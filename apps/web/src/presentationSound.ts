import { catCue, type PresentationEvent, type SoundCue } from "./presentationEvents";

export type AudioStatus = "muted" | "starting" | "ready" | "blocked" | "unsupported";
export type SoundBackend = {
  resume: () => Promise<boolean>;
  volume: (value: number) => void;
  play: (cue: SoundCue) => void;
  stop: () => void;
  suspend?: () => Promise<void>;
};
type Timers = {
  set: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clear: (timer: ReturnType<typeof setTimeout>) => void;
};
const timers: Timers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
};

export class PresentationAudio {
  private backend: SoundBackend | null = null;
  private enabled = false;
  private epoch = 0;
  private status: AudioStatus = "muted";
  private volumeValue = 45;
  private pending = new Set<ReturnType<typeof setTimeout>>();
  private seen = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly createBackend: () => SoundBackend | null,
    private readonly visible: () => boolean = () =>
      typeof document === "undefined" || document.visibilityState === "visible",
    private readonly clock: Timers = timers,
  ) {}

  getSnapshot = () => this.status;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private state(status: AudioStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.listeners) listener();
  }
  setVolume(value: number) {
    if (!Number.isFinite(value)) return;
    this.volumeValue = Math.max(0, Math.min(100, value));
    try {
      this.backend?.volume(this.volumeValue);
    } catch {
      this.cancel();
      this.state("blocked");
    }
  }

  // Called directly by a real button activation, before any asynchronous save.
  async enable(volume: number): Promise<boolean> {
    this.enabled = true;
    this.setVolume(volume);
    const epoch = ++this.epoch;
    try {
      this.backend ??= this.createBackend();
      if (!this.backend) {
        this.state("unsupported");
        return false;
      }
      this.backend.volume(this.volumeValue);
      this.state("starting");
      const ready = await this.backend.resume();
      if (epoch !== this.epoch || !this.enabled) {
        if (!this.enabled || !this.visible()) void this.backend.suspend?.().catch(() => undefined);
        return false;
      }
      this.state(ready ? "ready" : "blocked");
      return ready;
    } catch {
      if (epoch === this.epoch) this.state("blocked");
      return false;
    }
  }

  mute() {
    this.enabled = false;
    this.epoch += 1;
    this.cancel();
    this.state("muted");
    void this.backend?.suspend?.().catch(() => undefined);
  }
  cancel() {
    for (const timer of this.pending) this.clock.clear(timer);
    this.pending.clear();
    this.backend?.stop();
  }
  pause() {
    this.epoch += 1;
    this.cancel();
    if (this.enabled && this.status === "ready") this.state("blocked");
    void this.backend?.suspend?.().catch(() => undefined);
  }
  resumeIfActivated() {
    if (this.backend && this.enabled && this.visible()) void this.enable(this.volumeValue);
  }
  private play(cue: SoundCue) {
    if (!this.enabled || this.status !== "ready" || !this.visible() || this.volumeValue === 0)
      return;
    try {
      this.backend?.play(cue);
    } catch {
      this.cancel();
      this.state("blocked");
    }
  }
  test() {
    this.play("move");
  }

  present(event: PresentationEvent, catDelay: number) {
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value ?? "");
    // Mark silent/blocked events consumed too. Enabling sound cannot replay them.
    if (!this.enabled || this.status !== "ready" || !this.visible()) return;
    this.cancel();
    this.play(event.cue);
    if (this.status !== "ready") return;
    const cue = catCue(event);
    if (cue) {
      const timer = this.clock.set(() => {
        this.pending.delete(timer);
        this.play(cue);
      }, catDelay);
      this.pending.add(timer);
    }
  }
}

class BrowserSoundBackend implements SoundBackend {
  private readonly master: GainNode;
  private readonly noise: AudioBuffer;
  private readonly sources = new Set<AudioScheduledSourceNode>();
  private suspending: Promise<void> | null = null;
  constructor(private readonly context: AudioContext) {
    this.master = context.createGain();
    this.master.connect(context.destination);
    this.noise = context.createBuffer(1, Math.ceil(context.sampleRate * 0.13), context.sampleRate);
    const samples = this.noise.getChannelData(0);
    let seed = 179;
    for (let index = 0; index < samples.length; index += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      samples[index] = ((seed / 4294967296) * 2 - 1) * (1 - index / samples.length);
    }
  }
  async resume() {
    if (this.suspending) await this.suspending;
    if (this.context.state === "suspended") await this.context.resume();
    return this.context.state === "running";
  }
  async suspend() {
    if (this.context.state === "running") {
      const pending = this.context.suspend();
      this.suspending = pending;
      try {
        await pending;
      } finally {
        if (this.suspending === pending) this.suspending = null;
      }
    }
  }
  volume(value: number) {
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime((value / 100) * 0.3, now, 0.012);
  }
  stop() {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* A just-ended source is already silent. */
      }
    }
    this.sources.clear();
  }
  private source(source: AudioScheduledSourceNode, gain: GainNode, extra: AudioNode[] = []) {
    while (this.sources.size >= 2) {
      const oldest = this.sources.values().next().value;
      if (!oldest) break;
      try {
        oldest.stop();
      } catch {
        /* Already ended. */
      }
      this.sources.delete(oldest);
    }
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      gain.disconnect();
      for (const node of extra) node.disconnect();
    };
  }
  play(cue: SoundCue) {
    if (this.context.state !== "running") throw new Error("Audio needs user activation.");
    const now = this.context.currentTime;
    const gain = this.context.createGain();
    gain.connect(this.master);
    const wooden = cue === "move" || cue === "capture" || cue === "castle";
    if (wooden) {
      const source = this.context.createBufferSource();
      source.buffer = this.noise;
      const filter = this.context.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = cue === "capture" ? 330 : cue === "castle" ? 680 : 520;
      filter.Q.value = 1.8;
      source.connect(filter);
      filter.connect(gain);
      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(cue === "capture" ? 0.7 : 0.45, now + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      this.source(source, gain, [filter]);
      source.start(now);
      source.stop(now + 0.13);
      return;
    }
    const source = this.context.createOscillator();
    source.type = cue.startsWith("cat-") ? "triangle" : "sine";
    const duration = cue === "result" ? 0.46 : cue.startsWith("cat-") ? 0.28 : 0.22;
    const frequencies: number[] =
      cue === "cat-add"
        ? [440, 880, 660]
        : cue === "cat-remove"
          ? [600, 360, 260]
          : cue === "result"
            ? [392, 494, 587]
            : cue === "check"
              ? [440, 330, 440]
              : [523, 659, 784];
    source.frequency.setValueAtTime(frequencies[0] ?? 440, now);
    source.frequency.exponentialRampToValueAtTime(frequencies[1] ?? 440, now + duration * 0.45);
    source.frequency.exponentialRampToValueAtTime(frequencies[2] ?? 440, now + duration * 0.8);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.26, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    source.connect(gain);
    this.source(source, gain);
    source.start(now);
    source.stop(now + duration);
  }
}

let deviceAudio: PresentationAudio | undefined;
export function presentationAudio() {
  deviceAudio ??= new PresentationAudio(() => {
    if (typeof window === "undefined" || !window.AudioContext) return null;
    return new BrowserSoundBackend(new window.AudioContext());
  });
  return deviceAudio;
}
