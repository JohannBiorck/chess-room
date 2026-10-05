import { monitorEventLoopDelay } from "node:perf_hooks";

export class Samples {
  private values: number[] = [];
  add(value: number) {
    this.values.push(value);
    if (this.values.length > 256) this.values.shift();
  }
  percentile(fraction: number) {
    const sorted = [...this.values].sort((a, b) => a - b);
    return (
      Math.round((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0) * 100) / 100
    );
  }
}

/** Aggregate local diagnostics contain no URLs, tokens, names, or match identifiers. */
export class RuntimeMetrics {
  requests = 0;
  workerFailures = 0;
  readonly requestDuration = new Samples();
  readonly fanoutDelay = new Samples();
  private readonly eventLoop = monitorEventLoopDelay({ resolution: 20 });
  constructor() {
    this.eventLoop.enable();
  }
  snapshot() {
    return {
      requests: this.requests,
      workerFailures: this.workerFailures,
      requestDurationP95Ms: this.requestDuration.percentile(0.95),
      fanoutDelayP95Ms: this.fanoutDelay.percentile(0.95),
      eventLoopDelayP95Ms: Math.round(this.eventLoop.percentile(95) / 10_000) / 100,
      rssBytes: process.memoryUsage().rss,
    };
  }
  close() {
    this.eventLoop.disable();
  }
}
