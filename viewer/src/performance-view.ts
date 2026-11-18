import "./performance-view.css";
import { profiler, metrics, transferMetrics } from "./performance";
import { panelHeader } from "./ui/panel";
import { MetricSummaryTable } from "./ui/metric-summary-table";
import { TimeSeriesGraph } from "./ui/time-series-graph";

export function mountPerformancePanel(container: HTMLElement) {
  const results = document.createElement("div"); results.id = "profile-results";
  container.replaceChildren(panelHeader("Viewer performance"), results);
  const panels = [
    { id: "timing", unit: "ms", label: "Viewer timings", definitions: metrics },
    { id: "transfer", unit: "kB/s", label: "Payload transfer · rolling 1 s", definitions: transferMetrics },
  ].map(panel => {
    const layout = document.createElement("div"); layout.className = "timing-layout";
    const graph = new TimeSeriesGraph(), table = new MetricSummaryTable();
    graph.configure(`${panel.id}-chart`, panel.label, panel.unit, panel.id === "timing" ? 40 : 10);
    table.configure(panel.id, panel.label, panel.unit, panel.id === "transfer" ? "rolling 1 s" : "last 10 s", panel.definitions);
    layout.append(graph, table); results.append(layout);
    return { ...panel, graph, table };
  });
  const visibility = () => {
    profiler.reset();
  };
  profiler.start();
  document.addEventListener("visibilitychange", visibility);
  let visible = false;
  const observer = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; });
  observer.observe(container);
  let layouts: ReturnType<TimeSeriesGraph["measure"]>[] = [];
  return {
    measureFrame() {
      // Batch geometry reads before this frame changes any UI text or graph sizes.
      layouts = visible && profiler.enabled && !document.hidden ? panels.map(panel => panel.graph.measure()) : [];
    },
    renderFrame() {
      if (!profiler.enabled || document.hidden) return;
      profiler.sampleTransfer();
      // Keep collecting every frame; only build and paint summaries when shown.
      if (!layouts.length) return;
      const capture = profiler.snapshot();
      panels[0].table.describe("gpu", capture.gpuStatus);
      for (const [index, panel] of panels.entries()) {
        const series = panel.id === "timing" ? capture.metrics : capture.transfer;
        panel.table.update(series);
        panel.graph.update(series.map(metric => ({ ...metric, points: metric.key === "gpu" })), capture.end, capture.windowMs, layouts[index]);
      }
    },
    dispose() { observer.disconnect(); document.removeEventListener("visibilitychange", visibility); profiler.stop(); },
  };
}
