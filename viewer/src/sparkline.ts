import "./sparkline.css";
import { setAttribute, setSelectableText } from "./dom";
import { ViewerTooltip } from "./ui/tooltip";
import { formatMeasurement } from "./ui/format";

import { SparklineHistory } from "./sparkline-history";
import { groupColor, referenceDash } from "./ui/graph-style";
export { groupColor, neutralColor } from "./ui/graph-style";

type Series = { key: string; value?: number; color: string; dashed?: boolean; peak?: boolean; className?: string };

// Bounded ten-second histories, updated at most 10 Hz; no per-frame chart snapshots.
export function mountSparkline(container: HTMLElement, id: string, description: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = id; svg.classList.add("metric-chart");
  svg.setAttribute("viewBox", "0 0 100 48"); svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${description} Last 10 s.`);
  const plot = new ViewerTooltip(); plot.classList.add("metric-plot");
  container.tabIndex = 0;
  container.setAttribute("role", "group");
  container.setAttribute("aria-label", container.getAttribute("label") ?? description);
  plot.configure(svg, `${description}\nLast 10 s.`, `${id}-tooltip`, container);
  const tooltip = plot.content;
  container.append(plot);
  const lines = new Map<string, { path: SVGPathElement; history: SparklineHistory }>();
  let lastDraw = -Infinity;
  return {
    tooltip,
    reset() { lines.clear(); svg.replaceChildren(); lastDraw = -Infinity; },
    update(series: Series[], now: number) {
      for (const [key, line] of lines) if (!series.some(s => s.key === key)) {
        line.path.remove(); lines.delete(key); lastDraw = -Infinity;
      }
      for (const item of series) {
        let line = lines.get(item.key);
        if (!line) {
          const path = document.createElementNS(svg.namespaceURI, "path") as SVGPathElement;
          path.setAttribute("stroke", item.color);
          if (item.dashed) path.setAttribute("stroke-dasharray", referenceDash.join(" "));
          if (item.className) path.setAttribute("class", item.className);
          svg.append(path);
          line = { path, history: new SparklineHistory() }; lines.set(item.key, line);
          lastDraw = -Infinity;
        }
        line.history.add(now, item.value, item.peak);
      }
      if (now - lastDraw < 100) return;
      lastDraw = now;
      const values = [...lines.values()].flatMap(l => l.history.samples.flatMap(s => s.value === undefined ? [] : [s.value]));
      const min = Math.min(0, ...values), max = Math.max(1, ...values), range = max - min;
      for (const { path, history } of lines.values()) {
        let previous = -Infinity, data = "";
        for (const sample of history.samples) {
          if (sample.value === undefined) { previous = -Infinity; continue; }
          data += `${sample.at - previous <= 100 ? "L" : "M"}${((sample.at - now + 10_000) / 100).toFixed(2)},${(46 - (sample.value - min) / range * 42).toFixed(2)}`;
          previous = sample.at;
        }
        setAttribute(path, "d", data);
      }
    },
  };
}

export function mountGroupLegend(container: HTMLElement, unit: string, precision = 1) {
  const legend = document.createElement("div"); legend.className = "metric-groups";
  container.append(legend);
  const rows = new Map<number, { row: HTMLElement; label: HTMLElement; value: HTMLElement; note: HTMLElement }>();
  return (groups: { group: number; label?: string; onChange?: boolean; value?: number; status?: string }[]) => {
    const unique = [...new Map(groups.map(g => [g.group, g])).values()];
    for (const [group, item] of rows) if (!unique.some(g => g.group === group)) { item.row.remove(); rows.delete(group); }
    for (const group of unique) {
      let item = rows.get(group.group);
      if (!item) {
        const row = document.createElement("div"); row.className = "metric-group"; row.dataset.group = String(group.group);
        const label = document.createElement("span"); label.className = "group-label";
        label.style.setProperty("--group-color", groupColor(group.group));
        const value = document.createElement("span"); value.className = "group-median";
        const note = document.createElement("span"); note.className = "group-note";
        row.append(label, value, note); legend.append(row);
        item = { row, label, value, note }; rows.set(group.group, item);
      }
      setSelectableText(item.label, group.label ?? `Group ${group.group}`);
      setSelectableText(item.value, formatMeasurement(group.value, unit, precision));
      setSelectableText(item.note, group.status ?? (group.value === undefined ? "Unavailable" : group.onChange ? "On change" : ""));
    }
  };
}
