import Fastify, { type FastifyRequest, LogController } from "fastify";

export function buildServer(
  options: { logger?: boolean; logStream?: { write(message: string): void } } = {},
) {
  const server = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      options.logger === false
        ? false
        : {
            ...(options.logStream ? { stream: options.logStream } : {}),
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              'res.headers["set-cookie"]',
            ],
            serializers: {
              req(request: FastifyRequest) {
                return { id: request.id, method: request.method };
              },
              res(response: { statusCode: number }) {
                return { statusCode: response.statusCode };
              },
            },
          },
  });

  server.get("/api/health", async () => ({ status: "ok" }));

  return server;
}
