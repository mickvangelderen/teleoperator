import "./performance-view.css";
import { profiler, metrics, transferMetrics } from "./performance";
import { recording } from "./recording";
import { panelHeader } from "./ui/panel";
import { MetricSummaryTable } from "./ui/metric-summary-table";
import { TimeSeriesGraph } from "./ui/time-series-graph";

export function mountPerformancePanel(container: HTMLElement) {
  const status = document.createElement("span");
  status.id = "recording-status"; status.className = "tag"; status.setAttribute("role", "status"); status.hidden = true;
  const results = document.createElement("div"); results.id = "profile-results";
  container.replaceChildren(panelHeader("Performance", status), results);
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
    recording.add({ type: "visibility", state: document.visibilityState });
    profiler.reset();
  };
  profiler.start();
  document.addEventListener("visibilitychange", visibility);
  return {
    renderFrame() {
      if (!profiler.enabled || document.hidden) return;
      profiler.sampleTransfer();
      const capture = profiler.snapshot();
      panels[0].table.describe("gpu", capture.gpuStatus);
      for (const panel of panels) {
        const series = panel.id === "timing" ? capture.metrics : capture.transfer;
        panel.table.update(series);
        panel.graph.update(series.map(metric => ({ ...metric, points: metric.key === "gpu" })), capture.end, capture.windowMs);
      }
    },
    dispose() { document.removeEventListener("visibilitychange", visibility); profiler.stop(); },
  };
}
