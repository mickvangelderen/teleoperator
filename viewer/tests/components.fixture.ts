import "../src/style.css";
import "../src/performance-view.css";
import { MetricDisplay } from "../src/ui/metric-display";
import { PublicationGroup } from "../src/ui/publication-group";
import { MetricSummaryTable } from "../src/ui/metric-summary-table";
import { TimeSeriesGraph } from "../src/ui/time-series-graph";
import { panelHeader } from "../src/ui/panel";
import { mountSparkline, mountGroupLegend, groupColor } from "../src/sparkline";
import type { Request, Capabilities } from "../src/protocol";

const fixture = document.querySelector<HTMLElement>("#fixture")!;
fixture.innerHTML = `<h1>Viewer components</h1>
  <section class="metrics" aria-label="Example metrics">
    <viewer-metric id="example-metric" label="SAMPLE AGE" unit="ms" precision="2"></viewer-metric>
    <viewer-metric id="missing-metric" label="UNAVAILABLE" unit="Hz" precision="1"></viewer-metric>
  </section>`;
const metric = fixture.querySelector<MetricDisplay>("#example-metric")!;
metric.update(-3);
const chart = mountSparkline(metric, "example-chart", "Solid: measured. Dashed: reference.");
const legend = mountGroupLegend(chart.tooltip);
legend([{ group: 0 }, { group: 1 }]);
for (let now = 0; now <= 10000; now += 100) chart.update([
  { key: "measured", color: groupColor(0), value: now === 5000 ? undefined : 10 + 4 * Math.sin(now / 1000) },
  { key: "reference", color: groupColor(0), value: 20, dashed: true },
], now);
for (const size of ["default", "compact"]) {
  const panel = document.createElement("section"); panel.className = "panel"; panel.dataset.size = size;
  panel.innerHTML = `<div class="view-controls control-row">
    <label>Number <input type="number" value="20" min="0"></label>
    <label>Text <input type="text" value="Example" style="width: 100px"></label>
    <label>Choice <select><option>Live</option><option>Rest</option></select></label>
    <label><input type="checkbox" checked> Overlay</label>
    <label>Zoom <input type="range" min="0" max="10" value="5"></label>
    <button>Apply</button><button disabled>Disabled</button>
    <label class="field">Delay <input type="number" value="-1" aria-invalid="true" aria-describedby="error-${size}" style="width: 76px"> ms<span class="field-error" id="error-${size}">Enter zero or more.</span></label>
  </div>`;
  panel.prepend(panelHeader(`${size} controls`)); fixture.append(panel);
}
const capabilities: Capabilities = {
  groups: [90, 60], skeletons: [], descriptors: [0, 1].flatMap(group => [
    { id: `pose-${group}`, name: "Pose", description: "Example pose", kind: 10, formats: [10, 11], group, spaces: [1, 2] },
    { id: `button-${group}`, name: "Button", description: "Example button", kind: 2, formats: [1], group, spaces: [] },
  ]),
};
const requests: Request[] = [], errors: string[] = [];
const groups = capabilities.groups.map((_, group) => {
  const component = new PublicationGroup();
  component.configure(capabilities, group);
  component.update(undefined, false, new Map());
  fixture.append(component);
  return component;
});
fixture.addEventListener("publication-request", event => requests.push((event as CustomEvent<Request>).detail));
fixture.addEventListener("publication-error", event => errors.push((event as CustomEvent<string>).detail));
const layout = document.createElement("section"); layout.className = "panel timing-layout";
const graph = new TimeSeriesGraph(), summary = new MetricSummaryTable();
graph.configure("example-detail", "Example timings", "ms", 40);
const definitions = { example: { label: "Example", color: groupColor(0) } };
summary.configure("example", "Example timings", "ms", "last 10 s", definitions);
const series = [{ key: "example", color: groupColor(0), samples: [{ at: 0, value: 5 }, { at: 5000, value: undefined }, { at: 9000, value: 10 }, { at: 10000, value: 15 }], summary: { current: 15, median: 10, p95: 15, max: 15 } }];
summary.update(series);
layout.append(graph, summary); fixture.append(layout);
graph.update(series, 10000, 10000);
const state = { metric, chart, groups, requests, errors, graph, summary, series };
declare global { interface Window { componentsFixture: typeof state } }
window.componentsFixture = state;
