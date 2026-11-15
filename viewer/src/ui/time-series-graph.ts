import "./time-series-graph.css";
import { referenceDash, resolveColor } from "./graph-style";

type Series = {
  color: string;
  samples: { at: number; value?: number }[];
  dashed?: boolean;
  points?: boolean;
};

export class TimeSeriesGraph extends HTMLElement {
  readonly canvas = document.createElement("canvas");
  private unit = "";
  private minimumMax = 10;

  configure(id: string, label: string, unit: string, minimumMax: number) {
    this.unit = unit; this.minimumMax = minimumMax;
    this.canvas.id = id;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", `${label} in ${unit} over the last ten seconds. Exact summaries are in the adjacent table.`);
    this.replaceChildren(this.canvas);
  }

  measure() {
    return {
      width: this.canvas.clientWidth, height: this.canvas.clientHeight,
      ratio: Math.min(devicePixelRatio, 2), style: getComputedStyle(this.canvas),
    };
  }

  update(series: Series[], end: number, windowMs: number, layout = this.measure()) {
    const canvas = this.canvas, ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { width, height, ratio, style } = layout;
    if (!width || !height) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    const left = 40, right = width - 10, top = 16, bottom = height - 22;
    let maximum = this.minimumMax;
    for (const metric of series) for (const sample of metric.samples)
      if (sample.value !== undefined && Number.isFinite(sample.value)) maximum = Math.max(maximum, sample.value);
    const max = Math.ceil(maximum / 10) * 10;
    const x = (at: number) => left + (at - end + windowMs) / windowMs * (right - left);
    const y = (value: number) => bottom - value / max * (bottom - top);
    ctx.font = style.getPropertyValue("--graph-font").trim(); ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const value of [0, max / 2, max]) {
      ctx.strokeStyle = style.getPropertyValue("--graph-grid").trim();
      ctx.fillStyle = style.getPropertyValue("--text-muted").trim();
      ctx.beginPath(); ctx.moveTo(left, y(value)); ctx.lineTo(right, y(value)); ctx.stroke(); ctx.fillText(String(value), 2, y(value) + 3);
    }
    ctx.fillText(this.unit, 2, 10); ctx.fillText(`−${windowMs / 1000} s`, left, height - 3); ctx.fillText("now", right - 22, height - 3);
    for (const metric of series) {
      ctx.strokeStyle = ctx.fillStyle = resolveColor(metric.color, style);
      ctx.setLineDash(metric.dashed ? referenceDash : []);
      ctx.beginPath();
      let connected = false;
      for (const sample of metric.samples) {
        if (sample.value === undefined || !Number.isFinite(sample.value)) { connected = false; continue; }
        if (connected) ctx.lineTo(x(sample.at), y(sample.value)); else ctx.moveTo(x(sample.at), y(sample.value));
        connected = true;
        if (metric.points) ctx.fillRect(x(sample.at) - 1, y(sample.value) - 1, 3, 3);
      }
      ctx.stroke();
    }
  }
}
customElements.define("time-series-graph", TimeSeriesGraph);
