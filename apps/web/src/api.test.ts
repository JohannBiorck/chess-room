import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, request } from "./api";

function respondAfter(delayMs: number) {
  const fetch = vi.fn(
    (_path: string, options?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const signal = options?.signal;
        const abort = () => {
          clearTimeout(responseTimer);
          reject(signal?.reason);
        };
        const responseTimer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
        }, delayMs);
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      }),
  );
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  vi.useFakeTimers();
  // Native timeout scheduling is replaced so the simulated service delay is deterministic.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
      duration,
    );
    return controller.signal;
  });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("requests while a service starts", () => {
  it.each([
    { path: "/api/session", body: undefined },
    { path: "/api/session", body: { displayName: "Alex" } },
    { path: "/api/games", body: { rulesetId: "standard", color: "white", timeControl: "untimed" } },
    { path: "/api/invitations/join", body: { token: "invitation-code" } },
  ])(
    "waits for a slow first response to $path without replaying a mutation",
    async ({ path, body }) => {
      const fetch = respondAfter(15_000);
      let resolved = false;
      const pending = request(path, body).then((result) => {
        resolved = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(14_000);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ status: "ok" });
      expect(fetch).toHaveBeenCalledTimes(1);
      if (body) expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
    },
  );

  it("bounds even a startup request at seventy-five seconds", async () => {
    const fetch = respondAfter(100_000);
    let failure: unknown;
    const pending = request("/api/games", { rulesetId: "standard" }).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(74_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "NETWORK", status: 0 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      path: "/api/games/00000000-0000-4000-8000-000000000001/commands",
      body: {
        commandId: "stable-command",
        expectedRevision: 2,
        action: { type: "move", from: "e2", to: "e4" },
      },
    },
    { path: "/api/games/00000000-0000-4000-8000-000000000001", body: undefined },
  ])("keeps the twelve-second deadline for active game request $path", async ({ path, body }) => {
    const fetch = respondAfter(15_000);
    let failure: unknown;
    const pending = request(path, body).catch((error: unknown) => {
      failure = error;
    });
    await vi.advanceTimersByTimeAsync(11_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ code: "NETWORK", status: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (body) expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify(body));
  });
});
