import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundScheduler } from "./background.js";

describe("idle-aware background scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    let active = false;
    const work = vi.fn(async () => {});
    const nextWakeDelay = vi.fn(async (): Promise<number | null> => null);
    const onError = vi.fn();
    const scheduler = new BackgroundScheduler({
      hasSubscribers: () => active,
      work,
      nextWakeDelay,
      onError,
    });
    return {
      scheduler,
      work,
      nextWakeDelay,
      onError,
      setActive: (value: boolean) => {
        active = value;
      },
    };
  }

  it("does not perform database work while idle between its bounded maintenance wakeups", async () => {
    const { scheduler, work, nextWakeDelay } = setup();
    scheduler.wake();
    await scheduler.settled();
    expect(work).toHaveBeenCalledTimes(1);
    expect(nextWakeDelay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_599_999);
    expect(work).toHaveBeenCalledTimes(1);
    expect(nextWakeDelay).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("fires a persisted deadline without connected clients", async () => {
    const { scheduler, work, nextWakeDelay } = setup();
    nextWakeDelay.mockResolvedValueOnce(5_000);
    scheduler.wake();
    await scheduler.settled();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("polls while subscribed and stops polling when the last subscriber disconnects", async () => {
    const { scheduler, work, nextWakeDelay, setActive } = setup();
    setActive(true);
    scheduler.wake();
    await scheduler.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).toHaveBeenCalledTimes(5);
    expect(nextWakeDelay).not.toHaveBeenCalled();
    setActive(false);
    scheduler.wake();
    await scheduler.settled();
    const previous = work.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(work).toHaveBeenCalledTimes(previous);
    expect(nextWakeDelay).toHaveBeenCalledTimes(1);
    await scheduler.close();
  });

  it("replaces a distant timer immediately when a mutation creates an earlier deadline", async () => {
    const { scheduler, work, nextWakeDelay } = setup();
    nextWakeDelay.mockResolvedValueOnce(60_000);
    scheduler.wake();
    await scheduler.settled();
    nextWakeDelay.mockResolvedValueOnce(1_000);
    scheduler.wake();
    await scheduler.settled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.close();
  });

  it("coalesces concurrent wakeups and does not arm a stale deadline after async work", async () => {
    const { scheduler, work, nextWakeDelay } = setup();
    let complete: () => void = () => {};
    work.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    scheduler.wake();
    scheduler.wake();
    scheduler.wake();
    expect(work).toHaveBeenCalledTimes(1);
    complete();
    await scheduler.settled();
    expect(work).toHaveBeenCalledTimes(2);
    expect(nextWakeDelay).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.close();
  });

  it("retries failures with a bounded backoff instead of spinning on an overdue deadline", async () => {
    const { scheduler, work, onError } = setup();
    work.mockRejectedValueOnce(new Error("Database unavailable"));
    scheduler.wake();
    await scheduler.settled();
    expect(onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(work).toHaveBeenCalledTimes(2);
    await scheduler.close();
  });

  it("discards a deadline query result invalidated by a concurrent committed mutation", async () => {
    const { scheduler, work, nextWakeDelay } = setup();
    let complete: (value: number) => void = () => {};
    nextWakeDelay.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          complete = resolve;
        }),
    );
    scheduler.wake();
    await Promise.resolve();
    expect(nextWakeDelay).toHaveBeenCalledTimes(1);
    nextWakeDelay.mockResolvedValueOnce(1_000);
    scheduler.wake();
    complete(3_600_000);
    await scheduler.settled();
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(work).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.close();
  });

  it("awaits in-flight work on shutdown and cannot recreate timers afterwards", async () => {
    const { scheduler, work } = setup();
    let complete: () => void = () => {};
    work.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    scheduler.wake();
    const closed = scheduler.close();
    scheduler.wake();
    complete();
    await closed;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
