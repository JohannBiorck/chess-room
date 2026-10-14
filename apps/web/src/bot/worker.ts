import { botWorkerRequestSchema } from "./protocol";
import { chooseBotMove } from "./search";

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (message: unknown) => void;
};
scope.onmessage = (event) => {
  const parsed = botWorkerRequestSchema.safeParse(event.data);
  if (!parsed.success) return;
  const request = parsed.data;
  try {
    const result = chooseBotMove(request.position, {
      profile: request.profile,
      thinkMs: request.thinkMs,
    });
    scope.postMessage({ type: "result", requestId: request.requestId, result });
  } catch {
    scope.postMessage({ type: "failure", requestId: request.requestId });
  }
};
