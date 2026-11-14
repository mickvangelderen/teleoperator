import { median } from "./statistics";

export type FreshnessStatus = "Inactive" | "Unknown" | "Fresh" | "Late";
export type StreamFreshness = {
  id: number; group: number; generation: number; status: Exclude<FreshnessStatus, "Inactive">;
  ageMs?: number; thresholdMs?: number; latencyMs?: number; jitterMs?: number;
  intervalMs: number;
};
export type Freshness = {
  status: FreshnessStatus; atMs: number; streams: StreamFreshness[]; worst?: StreamFreshness;
};

export class FreshnessBaseline {
  private samples: { at: number; age: number }[] = [];
  latencyMs?: number;
  jitterMs?: number;
  thresholdMs?: number;

  observe(age: number | undefined, at: number, interval: number, networkLatency: number) {
    if (age === undefined || !Number.isFinite(age) || age < 0) {
      this.samples = []; this.latencyMs = this.jitterMs = this.thresholdMs = undefined;
      return;
    }
    // Bootstrap from clock probes so the first queued packet cannot establish a healthy baseline.
    this.latencyMs ??= networkLatency;
    this.jitterMs ??= 0;
    this.thresholdMs ??= networkLatency + 2 * interval;
    // A late packet must not raise the threshold that judges its own freshness.
    if (age > this.thresholdMs) return;
    while (this.samples.length && (this.samples[0].at <= at - 2000 || this.samples.length >= 2048)) this.samples.shift();
    this.samples.push({ at, age });
    this.latencyMs = median(this.samples.map(sample => sample.age));
    // Three median absolute deviations allow ordinary jitter without following isolated stalls.
    this.jitterMs = 3 * median(this.samples.map(sample => Math.abs(sample.age - this.latencyMs!)));
    this.thresholdMs = this.latencyMs + 2 * interval + this.jitterMs;
  }
}

export function summarizeFreshness(streams: StreamFreshness[], atMs: number): Freshness {
  const rank = { Fresh: 0, Unknown: 1, Late: 2 };
  let worst: StreamFreshness | undefined;
  for (const stream of streams) {
    if (!worst || rank[stream.status] > rank[worst.status] ||
      (rank[stream.status] === rank[worst.status] && (stream.ageMs ?? 0) / (stream.thresholdMs ?? 1) > (worst.ageMs ?? 0) / (worst.thresholdMs ?? 1))) worst = stream;
  }
  return { status: worst?.status ?? "Inactive", atMs, streams, worst };
}
