import { setAttribute } from "./dom";

export const groupColor = (group: number) => ["#237b72", "#aa6427", "#7861b3", "#367eae", "#ac527a", "#687d30"][group % 6];
export const neutralColor = "#66717b";

export class SparklineHistory {
  readonly samples: { at: number; value?: number }[] = [];
  add(now: number, value?: number, peak = false) {
    const at = Math.floor(now / 100) * 100, last = this.samples.at(-1);
    if (value !== undefined && !Number.isFinite(value)) value = undefined;
    if (last?.at === at) last.value = peak && value !== undefined ? Math.max(last.value ?? value, value) : value;
    else this.samples.push({ at, value });
    while (this.samples.length && this.samples[0].at < now - 10_000) this.samples.shift();
  }
}

type Series = { key: string; value?: number; color: string; dashed?: boolean; peak?: boolean; className?: string };

// Bounded ten-second histories, updated at most 10 Hz; no per-frame chart snapshots.
export function mountSparkline(container: HTMLElement, id: string, description: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = id; svg.classList.add("metric-chart");
  svg.setAttribute("viewBox", "0 0 100 48"); svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", `${description} Last 10 s.`);
  const plot = document.createElement("div"); plot.className = "metric-plot"; plot.title = "";
  const tooltip = document.createElement("div"); tooltip.className = "metric-tooltip";
  tooltip.id = `${id}-tooltip`; tooltip.setAttribute("role", "tooltip");
  tooltip.textContent = `${description}\nLast 10 s.`;
  svg.setAttribute("tabindex", "0"); svg.setAttribute("aria-describedby", tooltip.id);
  plot.append(svg, tooltip); container.append(plot);
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
          if (item.dashed) path.setAttribute("stroke-dasharray", "4 3");
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

export function mountGroupLegend(container: HTMLElement) {
  const legend = document.createElement("div"); legend.className = "metric-groups";
  container.append(legend);
  let previous = "";
  return (groups: { group: number; onChange?: boolean }[]) => {
    const unique = [...new Map(groups.map(g => [g.group, g])).values()];
    const key = unique.map(g => `${g.group}:${!!g.onChange}`).join(",");
    if (key === previous) return;
    previous = key;
    legend.replaceChildren(...unique.map(({ group, onChange }) => {
      const label = document.createElement("span"); label.className = "group-label";
      label.style.setProperty("--group-color", groupColor(group));
      label.textContent = `Group ${group}${onChange ? " · on change" : ""}`;
      return label;
    }));
  };
}
