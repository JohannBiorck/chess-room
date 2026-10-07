interface BackgroundOptions {
  hasSubscribers: () => boolean;
  work: () => Promise<void>;
  nextWakeDelay: () => Promise<number | null>;
  onError: () => void;
  activeIntervalMs?: number;
  maxIdleDelayMs?: number;
  retryDelayMs?: number;
}

/** Runs one worker at a time and lets an unused database suspend between deadlines. */
export class BackgroundScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private requested = false;
  private closed = false;

  constructor(private readonly options: BackgroundOptions) {}

  /** A committed mutation or subscription change invalidates the previous deadline. */
  wake(): void {
    if (this.closed) return;
    this.requested = true;
    this.clearTimer();
    if (!this.running) this.start();
  }

  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.requested = false;
    this.clearTimer();
    await this.settled();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private start(): void {
    this.running = this.cycle().finally(() => {
      this.running = undefined;
      if (!this.closed && this.requested) this.start();
    });
  }

  private arm(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        this.wake();
      },
      Math.min(2_147_483_647, Math.max(0, delay)),
    );
    this.timer.unref();
  }

  private async cycle(): Promise<void> {
    this.requested = false;
    try {
      await this.options.work();
      if (this.closed || this.requested) return;
      if (this.options.hasSubscribers()) {
        this.arm(this.options.activeIntervalMs ?? 250);
        return;
      }
      const next = await this.options.nextWakeDelay();
      if (this.closed || this.requested) return;
      if (next !== null && !Number.isFinite(next)) {
        throw new Error("Background deadline must be finite.");
      }
      this.arm(Math.min(next ?? Infinity, this.options.maxIdleDelayMs ?? 3_600_000));
    } catch {
      this.options.onError();
      this.requested = false;
      this.arm(this.options.retryDelayMs ?? 30_000);
    }
  }
}
