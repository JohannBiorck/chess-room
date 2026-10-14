import { BOT_PROFILES, type BotPositionView } from "@chess-room/contracts";
import { botWorkerResultSchema } from "./protocol";
import type { BotSearchResult } from "./search";

export function searchInWorker(
  view: BotPositionView,
  signal: AbortSignal,
): Promise<BotSearchResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The search was cancelled.", "AbortError"));
      return;
    }
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const constrained =
      window.matchMedia("(max-width: 620px)").matches ||
      (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4);
    const thinkMs = Math.min(BOT_PROFILES[view.profile].thinkMs, constrained ? 700 : 2000);
    let settled = false;
    const finish = (result: BotSearchResult | null, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      worker.terminate();
      if (result) resolve(result);
      else reject(error ?? new Error("The cat's search could not start."));
    };
    const cancel = () => finish(null, new DOMException("The search was cancelled.", "AbortError"));
    const timer = setTimeout(
      () => finish(null, new Error("The cat's search took too long.")),
      thinkMs + 1500,
    );
    signal.addEventListener("abort", cancel, { once: true });
    worker.onerror = () => finish(null);
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const parsed = botWorkerResultSchema.safeParse(event.data);
      if (parsed.success && parsed.data.requestId === view.requestId) finish(parsed.data.result);
      else if (
        typeof event.data === "object" &&
        event.data !== null &&
        "type" in event.data &&
        event.data.type === "failure"
      )
        finish(null);
    };
    worker.postMessage({
      type: "search",
      requestId: view.requestId,
      position: view.position,
      profile: view.profile,
      thinkMs,
    });
  });
}
