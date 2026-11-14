import "./metric-summary-table.css";
import { setAttribute, setText } from "../dom";
import { formatMeasurement } from "./format";

type Summary = { current: number; median: number; p95: number; max: number };
const columns = ["current", "median", "p95", "max"] as const;

export class MetricSummaryTable extends HTMLElement {
  private rows = new Map<string, { label: HTMLElement; cells: HTMLElement[] }>();

  configure(id: string, label: string, unit: string, window: string, definitions: Record<string, { label: string; color: string }>) {
    this.rows.clear();
    const table = document.createElement("table");
    table.className = "timing-summary";
    table.setAttribute("aria-label", `${label} in ${unit}`);
    table.innerHTML = `<thead><tr><th scope="col"></th><th scope="col">Latest</th><th scope="col">Median</th><th scope="col">P95</th><th scope="col">Max</th></tr></thead><tbody></tbody>`;
    table.querySelector("th")!.textContent = `${unit} · ${window}`;
    for (const [key, definition] of Object.entries(definitions)) {
      const row = document.createElement("tr"); row.id = `${id}-${key}`;
      const heading = document.createElement("th"); heading.scope = "row";
      heading.textContent = definition.label; heading.style.color = definition.color;
      const cells = columns.map(stat => {
        const cell = document.createElement("td"); cell.className = "numeric"; cell.dataset.stat = stat; cell.textContent = "—";
        return cell;
      });
      row.append(heading, ...cells);
      table.querySelector("tbody")!.append(row);
      this.rows.set(key, { label: heading, cells });
    }
    this.replaceChildren(table);
  }

  describe(key: string, description: string) {
    const label = this.rows.get(key)!.label;
    setAttribute(label, "title", description);
    setAttribute(label, "aria-label", `${label.textContent}: ${description}`);
  }

  update(series: { key: string; summary: Summary | null }[]) {
    for (const metric of series) {
      this.rows.get(metric.key)?.cells.forEach((cell, index) => setText(cell, formatMeasurement(metric.summary?.[columns[index]])));
    }
  }
}
customElements.define("metric-summary-table", MetricSummaryTable);
