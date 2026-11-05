// Uses the same browser timing APIs as OpenArm Teleop, with independent Viewer instrumentation.
import { recording } from "./recording";
export const metrics = {
  interval: { label: "Render interval", color: "#6276b0" },
  ui: { label: "UI + poses CPU", color: "#a34a71" },
  render: { label: "Three.js CPU", color: "#22775a" },
  receive: { label: "Message CPU", color: "#387b99" },
  gpu: { label: "GPU render", color: "#aa681f" },
} as const;
export type Metric = keyof typeof metrics;
const keys = Object.keys(metrics) as Metric[];
const windowMs = 10_000;

export class TimingHistory {
  private times: Float64Array;
  private values: Float64Array;
  private count = 0;
  private next = 0;
  constructor(private capacity = 8192) {
    this.times = new Float64Array(capacity);
    this.values = new Float64Array(capacity);
  }
  clear() { this.count = this.next = 0; }
  add(at: number, ms: number) {
    if (!Number.isFinite(at) || !Number.isFinite(ms) || ms < 0) return;
    const slot = this.next++ % this.capacity;
    this.times[slot] = at; this.values[slot] = ms;
    this.count = Math.min(this.count + 1, this.capacity);
  }
  samples(now: number) {
    const samples: { at: number; ms: number }[] = [];
    for (let i = this.next - this.count; i < this.next; i++) {
      const slot = i % this.capacity, at = this.times[slot];
      if (at >= now - windowMs && at <= now) samples.push({ at, ms: this.values[slot] });
    }
    return samples;
  }
}

export function summarize(samples: { ms: number }[]) {
  if (!samples.length) return null;
  const values = samples.map(s => s.ms).sort((a, b) => a - b), mid = Math.floor(values.length / 2);
  return {
    current: samples.at(-1)!.ms,
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
  private histories = Object.fromEntries(keys.map(key => [key, new TimingHistory()])) as Record<Metric, TimingHistory>;
  private gpu?: GpuTimer;
  private previousRender: number | null = null;
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
    for (const history of Object.values(this.histories)) history.clear();
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
    };
  }
}
export const profiler = new Profiler();

export function mountPerformancePanel(container: HTMLElement) {
  container.innerHTML = `<div class="panel-header"><h2>Performance</h2><span class="tag" id="recording-status" role="status" hidden></span></div>
    <div id="profile-results" class="timing-layout"><canvas id="timing-chart" role="img" aria-label="Last ten seconds of Viewer timings in milliseconds. Exact summaries are in the adjacent table."></canvas>
    <table class="timing-summary" aria-label="Viewer timings in milliseconds"><thead><tr><th>ms · last 10 s</th><th>Latest</th><th>Median</th><th>P95</th><th>Max</th></tr></thead><tbody>${keys.map(key => `<tr id="timing-${key}"><th scope="row" style="color:${metrics[key].color}">${metrics[key].label}</th>${["current", "median", "p95", "max"].map(stat => `<td data-stat="${stat}">—</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
  const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
  const ctx = canvas.getContext("2d");
  const refresh = () => {
    const capture = profiler.snapshot();
    const gpuLabel = container.querySelector<HTMLElement>("#timing-gpu th")!;
    gpuLabel.title = capture.gpuStatus;
    gpuLabel.setAttribute("aria-label", `GPU render: ${capture.gpuStatus}`);
    for (const metric of capture.metrics) {
      container.querySelectorAll<HTMLElement>(`#timing-${metric.key} [data-stat]`).forEach(cell => {
        cell.textContent = metric.summary ? metric.summary[cell.dataset.stat as keyof typeof metric.summary].toFixed(2) : "—";
      });
    }
    draw(capture);
  };
  const draw = (capture: ReturnType<Profiler["snapshot"]>) => {
    if (!ctx) return;
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = Math.min(devicePixelRatio, 2);
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 40, right = width - 10, top = 16, bottom = height - 22;
    const max = Math.ceil(Math.max(40, ...capture.metrics.map(m => m.summary?.max ?? 0)) / 10) * 10;
    const x = (at: number) => left + (at - capture.end + windowMs) / windowMs * (right - left);
    const y = (ms: number) => bottom - ms / max * (bottom - top);
    ctx.font = "10px system-ui"; ctx.lineWidth = 1;
    for (const ms of [0, max / 2, max]) {
      ctx.strokeStyle = "#dce4de"; ctx.fillStyle = "#53675b";
      ctx.beginPath(); ctx.moveTo(left, y(ms)); ctx.lineTo(right, y(ms)); ctx.stroke(); ctx.fillText(String(ms), 2, y(ms) + 3);
    }
    ctx.fillText("ms", 2, 10); ctx.fillText("−10 s", left, height - 3); ctx.fillText("now", right - 22, height - 3);
    for (const metric of capture.metrics) {
      ctx.strokeStyle = ctx.fillStyle = metric.color;
      ctx.beginPath();
      metric.samples.forEach((sample, i) => {
        if (i) ctx.lineTo(x(sample.at), y(sample.ms)); else ctx.moveTo(x(sample.at), y(sample.ms));
      });
      ctx.stroke();
      if (metric.key === "gpu") for (const sample of metric.samples) ctx.fillRect(x(sample.at) - 1, y(sample.ms) - 1, 3, 3);
    }
  };
  const visibility = () => {
    recording.add({ type: "visibility", state: document.visibilityState });
    profiler.reset();
  };
  profiler.start();
  document.addEventListener("visibilitychange", visibility);
  const timer = setInterval(() => { if (profiler.enabled && !document.hidden) refresh(); }, 200);
  return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); profiler.stop(); };
}
