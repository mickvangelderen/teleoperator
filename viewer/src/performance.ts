// Uses the same browser timing APIs as OpenArm Teleop, with independent Viewer instrumentation.
import { recording } from "./recording";
import { setAttribute, setText } from "./dom";
export const metrics = {
  frame: { label: "Animation frame", color: "#656565" },
  interval: { label: "Render interval", color: "#6276b0" },
  poseArrival: { label: "Pose arrival interval", color: "#c04c36" },
  controllerArrival: { label: "Input arrival interval", color: "#9671ab" },
  bodyArrival: { label: "Body arrival interval", color: "#708b22" },
  ui: { label: "UI CPU", color: "#a34a71" },
  scene: { label: "Poses + body CPU", color: "#8b662a" },
  render: { label: "Three.js CPU", color: "#22775a" },
  receive: { label: "Message CPU", color: "#387b99" },
  gpu: { label: "GPU render", color: "#aa681f" },
} as const;
export type Metric = keyof typeof metrics;
const keys = Object.keys(metrics) as Metric[];
const windowMs = 10_000;
export const transferMetrics = {
  received: { label: "Received total", color: "#387b99" },
  sent: { label: "Sent total", color: "#22775a" },
  pose: { label: "Poses", color: "#c04c36" },
  controller: { label: "Inputs", color: "#9671ab" },
  body: { label: "Body", color: "#708b22" },
} as const;
type TransferMetric = keyof typeof transferMetrics;
type TrackingType = "pose" | "controller" | "body";
const transferKeys = Object.keys(transferMetrics) as TransferMetric[];

// Exact payload bytes in (now - 1000 ms, now], including partial startup windows.
export class ByteRate {
  private packets: { at: number; bytes: number }[] = [];
  private first = 0;
  private bytes = 0;
  add(at: number, bytes: number) {
    this.rate(at);
    this.packets.push({ at, bytes });
    this.bytes += bytes;
  }
  rate(now: number) {
    while (this.first < this.packets.length && this.packets[this.first].at <= now - 1000)
      this.bytes -= this.packets[this.first++].bytes;
    if (this.first > 512 || this.first === this.packets.length) {
      this.packets = this.packets.slice(this.first); this.first = 0;
    }
    return this.bytes;
  }
}

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
  private rates = Object.fromEntries(transferKeys.map(key => [key, new ByteRate()])) as Record<TransferMetric, ByteRate>;
  private arrivals = new Map<TrackingType, { stream: string; at: number }>();
  private gpu?: GpuTimer;
  private previousRender: number | null = null;
  private previousFrame: number | null = null;
  private generation = 0;
  attach(gl: WebGL2RenderingContext, revision: string) {
    this.gpu?.cancel();
    this.threeRevision = revision;
    recording.add({ type: "renderer", threeRevision: revision });
    this.gpu = new GpuTimer(gl, status => {
      if (status !== this.gpuStatus) recording.add({ type: "gpu-status", status });
      this.gpuStatus = status;
    });
  }
  reset() {
    this.generation++;
    if (!recording.active) this.gpu?.cancel();
    this.previousRender = null;
    this.previousFrame = null;
    this.arrivals.clear();
    for (const history of [...Object.values(this.histories), ...Object.values(this.transferHistories)]) history.clear();
  }
  start() { this.reset(); this.enabled = true; }
  stop() { this.enabled = false; if (!recording.active) this.gpu?.cancel(); }
  begin() { return (this.enabled && !document.hidden) || recording.active ? performance.now() : null; }
  private sample(metric: Metric, start: number, ms: number, generation = this.generation) {
    recording.add({ type: "timing", metric, startMs: start, durationMs: ms });
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
  trackingArrival(type: TrackingType, stream: string, bytes: number, at: number) {
    this.rates[type].add(at, bytes);
    const previous = this.arrivals.get(type);
    if (previous?.stream === stream) this.sample(`${type}Arrival`, at, at - previous.at);
    this.arrivals.set(type, { stream, at });
  }
  sampleTransfer(now = performance.now()) {
    for (const key of transferKeys) {
      const bytesPerSecond = this.rates[key].rate(now);
      recording.add({ type: "transfer-rate", metric: key, windowMs: 1000, bytesPerSecond }, undefined, now);
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

export function mountPerformancePanel(container: HTMLElement) {
  const panels = [
    { id: "timing", unit: "ms", label: "Viewer timings", definitions: metrics },
    { id: "transfer", unit: "kB/s", label: "Payload transfer · rolling 1 s", definitions: transferMetrics },
  ];
  container.innerHTML = `<div class="panel-header"><h2>Performance</h2><span class="tag" id="recording-status" role="status" hidden></span></div>
    <div id="profile-results">${panels.map(panel => `<div class="timing-layout"><canvas id="${panel.id}-chart" role="img" aria-label="${panel.label} in ${panel.unit} over the last ten seconds. Exact summaries are in the adjacent table."></canvas>
    <table class="timing-summary" aria-label="${panel.label} in ${panel.unit}"><thead><tr><th>${panel.unit} · ${panel.id === "transfer" ? "rolling 1 s" : "last 10 s"}</th><th>Latest</th><th>Median</th><th>P95</th><th>Max</th></tr></thead><tbody>${Object.entries(panel.definitions).map(([key, definition]) => `<tr id="${panel.id}-${key}"><th scope="row" style="color:${definition.color}">${definition.label}</th>${["current", "median", "p95", "max"].map(stat => `<td data-stat="${stat}">—</td>`).join("")}</tr>`).join("")}</tbody></table></div>`).join("")}</div>`;
  const refresh = () => {
    const capture = profiler.snapshot();
    const gpuLabel = container.querySelector<HTMLElement>("#timing-gpu th")!;
    setAttribute(gpuLabel, "title", capture.gpuStatus);
    setAttribute(gpuLabel, "aria-label", `GPU render: ${capture.gpuStatus}`);
    for (const panel of panels) {
      const series = panel.id === "timing" ? capture.metrics : capture.transfer;
      for (const metric of series) {
        container.querySelectorAll<HTMLElement>(`#${panel.id}-${metric.key} [data-stat]`).forEach(cell => {
          setText(cell, metric.summary ? metric.summary[cell.dataset.stat as keyof typeof metric.summary].toFixed(2) : "—");
        });
      }
      draw(container.querySelector<HTMLCanvasElement>(`#${panel.id}-chart`)!, series, capture.end, panel.unit);
    }
  };
  const draw = (canvas: HTMLCanvasElement, series: ReturnType<Profiler["snapshot"]>["metrics"] | ReturnType<Profiler["snapshot"]>["transfer"], end: number, unit: string) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = Math.min(devicePixelRatio, 2);
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 40, right = width - 10, top = 16, bottom = height - 22;
    const max = Math.ceil(Math.max(unit === "ms" ? 40 : 10, ...series.map(m => m.summary?.max ?? 0)) / 10) * 10;
    const x = (at: number) => left + (at - end + windowMs) / windowMs * (right - left);
    const y = (ms: number) => bottom - ms / max * (bottom - top);
    ctx.font = "10px system-ui"; ctx.lineWidth = 1;
    for (const ms of [0, max / 2, max]) {
      ctx.strokeStyle = "#dce4de"; ctx.fillStyle = "#53675b";
      ctx.beginPath(); ctx.moveTo(left, y(ms)); ctx.lineTo(right, y(ms)); ctx.stroke(); ctx.fillText(String(ms), 2, y(ms) + 3);
    }
    ctx.fillText(unit, 2, 10); ctx.fillText("−10 s", left, height - 3); ctx.fillText("now", right - 22, height - 3);
    for (const metric of series) {
      ctx.strokeStyle = ctx.fillStyle = metric.color;
      ctx.beginPath();
      metric.samples.forEach((sample, i) => {
        if (i) ctx.lineTo(x(sample.at), y(sample.value)); else ctx.moveTo(x(sample.at), y(sample.value));
      });
      ctx.stroke();
      if (metric.key === "gpu") for (const sample of metric.samples) ctx.fillRect(x(sample.at) - 1, y(sample.value) - 1, 3, 3);
    }
  };
  let dirty = true;
  const visibility = () => {
    recording.add({ type: "visibility", state: document.visibilityState });
    profiler.reset();
    dirty = true;
  };
  profiler.start();
  document.addEventListener("visibilitychange", visibility);
  const timer = setInterval(() => {
    profiler.sampleTransfer();
    dirty = true;
  }, 200);
  return {
    renderFrame() {
      if (!dirty || !profiler.enabled || document.hidden) return;
      dirty = false;
      refresh();
    },
    dispose() { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); profiler.stop(); },
  };
}
