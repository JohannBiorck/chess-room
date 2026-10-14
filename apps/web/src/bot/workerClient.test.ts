import { BOT_ALGORITHM, type BotPositionView } from "@chess-room/contracts";
import { createEngineState, getEngineSearchPosition } from "@chess-room/game-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchInWorker } from "./workerClient";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  message: unknown;
  constructor() {
    FakeWorker.instances.push(this);
  }
  terminate() {
    this.terminated = true;
  }
  postMessage(message: unknown) {
    this.message = message;
  }
}
const view: BotPositionView = {
  gameId: "17936ec6-8299-494c-9e09-c3f9ac1b9c82",
  revision: 0,
  requestId: "cd4c98c0-1b3a-45f7-a445-9b918479df1f",
  profile: "strong",
  algorithm: BOT_ALGORITHM,
  position: getEngineSearchPosition(createEngineState()),
};
function setup() {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  FakeWorker.instances = [];
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Worker cancellation and watchdog", () => {
  it("immediately terminates compute on abort", async () => {
    setup();
    const abort = new AbortController();
    const promise = searchInWorker(view, abort.signal);
    const assertion = expect(promise).rejects.toMatchObject({ name: "AbortError" });
    abort.abort();
    await assertion;
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
  it("ignores old request results and terminates after a current result", async () => {
    setup();
    const promise = searchInWorker(view, new AbortController().signal);
    const worker = FakeWorker.instances[0];
    const result = {
      algorithm: BOT_ALGORITHM,
      move: { from: "e2", to: "e4" },
      score: 5,
      depth: 2,
      nodes: 30,
      elapsedMs: 4,
      exhausted: false,
    };
    worker?.onmessage?.({
      data: { type: "result", requestId: "8b5376cc-2b53-46d3-854d-992cd67527a9", result },
    } as MessageEvent<unknown>);
    expect(worker?.terminated).toBe(false);
    worker?.onmessage?.({
      data: { type: "result", requestId: view.requestId, result },
    } as MessageEvent<unknown>);
    await expect(promise).resolves.toEqual(result);
    expect(worker?.terminated).toBe(true);
  });
  it("kills a stuck worker even if its internal clock never returns", async () => {
    setup();
    vi.useFakeTimers();
    const promise = searchInWorker(view, new AbortController().signal);
    const assertion = expect(promise).rejects.toThrow("too long");
    await vi.advanceTimersByTimeAsync(3301);
    await assertion;
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });
});
