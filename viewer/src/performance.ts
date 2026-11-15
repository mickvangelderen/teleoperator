// Uses the same browser timing APIs as OpenArm Teleop, with independent Viewer instrumentation.
import { RollingRate } from "./statistics";
export const metrics = {
  frame: { label: "Animation frame", color: "var(--series-frame)" },
  interval: { label: "Render interval", color: "var(--series-interval)" },
  trackingArrival: { label: "Subscription arrival interval", color: "var(--series-tracking)" },
  ui: { label: "UI CPU", color: "var(--series-ui)" },
  scene: { label: "Poses + body CPU", color: "var(--series-scene)" },
  render: { label: "Three.js CPU", color: "var(--series-render)" },
  receive: { label: "Message CPU", color: "var(--series-receive)" },
  gpu: { label: "GPU render", color: "var(--series-gpu)" },
} as const;
export type Metric = keyof typeof metrics;
const keys = Object.keys(metrics) as Metric[];
const windowMs = 10_000;
export const transferMetrics = {
  received: { label: "Received total", color: "var(--series-receive)" },
  sent: { label: "Sent total", color: "var(--series-render)" },
  tracking: { label: "Accepted tracking packets", color: "var(--series-tracking)" },
} as const;
type TransferMetric = keyof typeof transferMetrics;
const transferKeys = Object.keys(transferMetrics) as TransferMetric[];

export class MetricHistory {
  private times: Float64Array;
  private values: Float64Array;
  private count = 0;
  private next = 0;
  constructor(private capacity = 8192) {
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }
  clear() { this.count = this.next = 0; }
  add(at: number, value: number) {
    if (!Number.isFinite(at) || !Number.isFinite(value) || value < 0) return;
    const slot = this.next++ % this.capacity;
    this.times[slot] = at; this.values[slot] = value;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  samples(now: number) {
    const samples: { at: number; value: number }[] = [];
    for (let i = this.next - this.count; i < this.next; i++) {
      const slot = i % this.capacity, at = this.times[slot];
      if (at >= now - windowMs && at <= now) samples.push({ at, value: this.values[slot] });
    }
    return samples;
  }
}

export function summarize(samples: { value: number }[]) {
  if (!samples.length) return null;
  const values = samples.map(s => s.value).sort((a, b) => a - b), mid = Math.floor(values.length / 2);
  return {
    current: samples.at(-1)!.value,
    median: values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2,
    p95: values[Math.ceil(values.length * 0.95) - 1],
    max: values.at(-1)!,
  };
}

export class GpuTimer {
  private ext;
  private query: WebGLQuery | null = null;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private last = -Infinity;
  constructor(private gl: WebGL2RenderingContext, private status: (text: string) => void) {
    this.ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
    status(this.ext ? "GPU ready · sampled at most 5 Hz" : "GPU timing unavailable on this browser / GPU");
  }
  begin(now: number) {
    if (!this.ext || this.query || now - this.last < 200 || this.gl.isContextLost()) return null;
    if (this.gl.getParameter(this.ext.GPU_DISJOINT_EXT)) return null;
    const query = this.gl.createQuery();
    if (!query) { this.status("GPU query allocation failed"); return null; }
    this.query = query; this.last = now;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    return query;
  }
  end(query: WebGLQuery | null, result: (ms: number) => void) {
    if (!query || query !== this.query || !this.ext) return;
    const gl = this.gl, ext = this.ext, started = performance.now();
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    const poll = () => {
      if (query !== this.query) return;
      if (gl.isContextLost()) this.status("GPU timing unavailable · context lost");
      else if (gl.getParameter(ext.GPU_DISJOINT_EXT)) this.status("GPU timing interrupted · invalid sample discarded");
      else if (performance.now() - started > 2000) this.status("GPU query timed out · sample discarded");
      else if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        this.pollTimer = setTimeout(poll, 16);
        return;
      } else {
        const ms = Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6;
        if (Number.isFinite(ms) && ms >= 0) {
          result(ms); this.status("GPU sampled at most 5 Hz");
        } else this.status("GPU returned an invalid timing · sample discarded");
      }
      this.cancel();
    };
    this.pollTimer = setTimeout(poll, 16);
  }
  cancel() {
    clearTimeout(this.pollTimer);
    if (this.query) this.gl.deleteQuery(this.query);
    this.query = null;
  }
}

class Profiler {
  enabled = false;
  gpuStatus = "GPU timing waiting for WebGL";
  threeRevision = "unavailable";
  private histories = Object.fromEntries(keys.map(key => [key, new MetricHistory()])) as Record<Metric, MetricHistory>;
  private transferHistories = Object.fromEntries(transferKeys.map(key => [key, new MetricHistory()])) as Record<TransferMetric, MetricHistory>;
  private rates = Object.fromEntries(transferKeys.map(key => [key, new RollingRate()])) as Record<TransferMetric, RollingRate>;
  private arrivals = new Map<number, { stream: string; at: number }>();
  private gpu?: GpuTimer;
  private previousRender: number | null = null;
  private previousFrame: number | null = null;
  private generation = 0;
  attach(gl: WebGL2RenderingContext, revision: string) {
    this.gpu?.cancel();
    this.threeRevision = revision;
    this.gpu = new GpuTimer(gl, status => {
      this.gpuStatus = status;
    });
  }
  reset() {
    this.generation++;
    this.gpu?.cancel();
    this.previousRender = null;
    this.previousFrame = null;
    for (const history of Object.values(this.histories)) history.clear();
    this.resetConnectionMetrics();
  }
  resetConnectionMetrics() {
    this.arrivals.clear();
    this.histories.trackingArrival.clear();
    this.histories.receive.clear();
    for (const key of transferKeys) {
      this.rates[key].clear();
      this.transferHistories[key].clear();
    }
  }
  start() { this.reset(); this.enabled = true; }
  stop() { this.enabled = false; this.gpu?.cancel(); }
  begin() { return this.enabled && !document.hidden ? performance.now() : null; }
  private sample(metric: Metric, start: number, ms: number, generation = this.generation) {
    if (this.enabled && generation === this.generation) this.histories[metric].add(start, ms);
  }
  end(metric: Metric, start: number | null) {
    if (start !== null) this.sample(metric, start, performance.now() - start);
  }
  animationFrame(now: number) {
    if (this.previousFrame !== null) this.sample("frame", now, now - this.previousFrame);
    this.previousFrame = now;
  }
  transfer(direction: "received" | "sent", bytes: number, at: number) { this.rates[direction].add(at, bytes); }
  trackingArrival(id: number, stream: string, bytes: number, at: number) {
    this.rates.tracking.add(at, bytes);
    const previous = this.arrivals.get(id);
    if (previous?.stream === stream) this.sample("trackingArrival", at, at - previous.at);
    this.arrivals.set(id, { stream, at });
  }
  sampleTransfer(now = performance.now()) {
    for (const key of transferKeys) {
      const bytesPerSecond = this.rates[key].rate(now);
      if (this.enabled) this.transferHistories[key].add(now, bytesPerSecond / 1000);
    }
  }
  beginRender() {
    const start = this.begin();
    if (start === null) return null;
    if (this.previousRender !== null) this.sample("interval", start, start - this.previousRender);
    this.previousRender = start;
    return { start, query: this.gpu?.begin(start) ?? null, generation: this.generation };
  }
  endRender(token: ReturnType<Profiler["beginRender"]>) {
    if (!token) return;
    this.end("render", token.start);
    this.gpu?.end(token.query, ms => {
      this.sample("gpu", token.start, ms, token.generation);
    });
  }
  snapshot() {
    const end = performance.now();
    return {
      end, windowMs, threeRevision: this.threeRevision, gpuStatus: this.gpuStatus,
      metrics: keys.map(key => {
        const samples = this.histories[key].samples(end);
        return { key, ...metrics[key], summary: summarize(samples), samples };
      }),
      transfer: transferKeys.map(key => {
        const samples = this.transferHistories[key].samples(end);
        return { key, ...transferMetrics[key], summary: summarize(samples), samples };
      }),
    };
  }
}
export const profiler = new Profiler();
