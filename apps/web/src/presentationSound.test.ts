import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PresentationEvent } from "./presentationEvents";
import { PresentationAudio, type SoundBackend } from "./presentationSound";

const event = (id = "one", action: "add" | "remove" | "none" = "add"): PresentationEvent => ({
  id,
  gameId: "game",
  revision: 1,
  ply: 1,
  createdAt: 0,
  cue: "move",
  outcome: null,
  kind: "move",
  move: { from: "e2", to: "e4" },
  movementId: "move",
  transition: { moving: [], captured: [], boardAfterMove: [], castle: false },
  cat: { ply: 1, color: "white", action, ...(action === "none" ? {} : { square: "c3" }) },
});
function setup(ready = true) {
  const backend: SoundBackend = {
    resume: vi.fn(async () => ready),
    volume: vi.fn(),
    play: vi.fn(),
    stop: vi.fn(),
    suspend: vi.fn(async () => undefined),
  };
  let visible = true;
  const create = vi.fn(() => backend);
  const audio = new PresentationAudio(create, () => visible);
  return {
    audio,
    backend,
    create,
    hide: () => {
      visible = false;
    },
    show: () => {
      visible = true;
    },
  };
}

describe("confirmed sound scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("does not create audio before activation or replay previously silent events", async () => {
    const { audio, backend, create } = setup();
    audio.present(event(), 560);
    expect(create).not.toHaveBeenCalled();
    await audio.enable(40);
    audio.present(event(), 560);
    vi.runAllTimers();
    expect(backend.play).not.toHaveBeenCalled();
    audio.present(event("new"), 560);
    expect(backend.play).toHaveBeenCalledWith("move");
  });
  it("plays one primary and one cat cue across duplicate acknowledgements", async () => {
    const { audio, backend } = setup();
    await audio.enable(45);
    audio.present(event(), 560);
    audio.present(event(), 560);
    expect(vi.mocked(backend.play).mock.calls).toEqual([["move"]]);
    vi.advanceTimersByTime(560);
    audio.present(event(), 560);
    expect(vi.mocked(backend.play).mock.calls).toEqual([["move"], ["cat-add"]]);
  });
  it("keeps cat audio available when reduced motion has no animated paw phase", async () => {
    const { audio, backend } = setup();
    await audio.enable(45);
    audio.present(event("reduced", "remove"), 0);
    vi.advanceTimersByTime(0);
    expect(vi.mocked(backend.play).mock.calls).toEqual([["move"], ["cat-remove"]]);
  });
  it("drops scheduled cat cues on mute, hide, cancellation and a newer turn", async () => {
    for (const reason of ["mute", "hide", "cancel", "newer"] as const) {
      const { audio, backend, hide } = setup();
      await audio.enable(45);
      audio.present(event(reason), 560);
      if (reason === "mute") audio.mute();
      if (reason === "hide") {
        hide();
        audio.pause();
      }
      if (reason === "cancel") audio.cancel();
      if (reason === "newer") audio.present(event("second", "none"), 560);
      vi.runAllTimers();
      expect(vi.mocked(backend.play).mock.calls.flat()).not.toContain("cat-add");
    }
  });
  it("fails silently when autoplay or API support is unavailable and never queues missed cues", async () => {
    const blocked = setup(false);
    expect(await blocked.audio.enable(40)).toBe(false);
    expect(blocked.audio.getSnapshot()).toBe("blocked");
    blocked.audio.present(event(), 560);
    expect(blocked.backend.play).not.toHaveBeenCalled();
    const unsupported = new PresentationAudio(() => null);
    expect(await unsupported.enable(40)).toBe(false);
    expect(unsupported.getSnapshot()).toBe("unsupported");
    unsupported.present(event(), 560);
    vi.runAllTimers();
  });
  it("does not turn an in-flight activation back on after mute", async () => {
    const { audio, backend } = setup();
    let ready: ((value: boolean) => void) | undefined;
    vi.mocked(backend.resume).mockImplementation(
      () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
    );
    const enabling = audio.enable(45);
    audio.mute();
    ready?.(true);
    expect(await enabling).toBe(false);
    expect(audio.getSnapshot()).toBe("muted");
    audio.present(event(), 0);
    expect(backend.play).not.toHaveBeenCalled();
  });
  it("keeps zero volume silent and handles an interrupted device without blocking commands", async () => {
    const { audio, backend } = setup();
    await audio.enable(0);
    audio.present(event(), 0);
    vi.runAllTimers();
    expect(backend.play).not.toHaveBeenCalled();
    audio.setVolume(30);
    vi.mocked(backend.play).mockImplementation(() => {
      throw new Error("Interrupted");
    });
    expect(() => audio.present(event("after-interruption"), 0)).not.toThrow();
    expect(audio.getSnapshot()).toBe("blocked");
  });
});
