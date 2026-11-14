import "./sample-selection-table.css";
import { setAttribute, setText } from "../dom";
import { kindNames, formatNames, spaceNames, preferredFormat, referenceFields } from "../protocol";
import type { Capabilities, Selection } from "../protocol";
import { valueText } from "../tracking-view";
import type { CurrentValue } from "../tracking-view";

type Row = { value: HTMLElement; check: HTMLInputElement; format: HTMLSelectElement; space: HTMLSelectElement; row: HTMLElement };

export class SampleSelectionTable extends HTMLElement {
  private rows = new Map<number, Row>();
  private capabilities?: Capabilities;

  configure(c: Capabilities, group: number) {
    this.capabilities = c;
    this.rows.clear();
    this.classList.add("sample-table-wrap");
    this.innerHTML = `<table class="sample-table" data-size="compact" aria-label="Group ${group} sample selection"><thead><tr><th>Select</th><th>Sample</th><th>Kind</th><th>Format</th><th>Space</th><th>Current value</th></tr></thead><tbody></tbody></table>`;
    const tbody = this.querySelector("tbody")!;
    c.descriptors.forEach((d, index) => {
      if (d.group !== group) return;
      const row = document.createElement("tr"); row.dataset.descriptor = d.id;
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = true; check.setAttribute("aria-label", `Select ${d.name || d.id}`);
      const name = document.createElement("span"); name.textContent = d.name || d.id; name.title = `${d.id}\n${d.description}`;
      const references = referenceFields(d.kind).flatMap(field => d[field] == null ? [] : [`${kindNames[c.descriptors[d[field]!].kind]}: ${c.descriptors[d[field]!].name || c.descriptors[d[field]!].id}`]);
      if (d.revision_of !== undefined) references.push(`Versions group ${d.revision_of}`);
      name.title += references.length ? `\n${references.join("\n")}` : "";
      const kind = document.createElement("span"); kind.textContent = kindNames[d.kind];
      const format = document.createElement("select"); format.setAttribute("aria-label", `Format for ${d.name || d.id}`);
      for (const f of d.formats) format.add(new Option(formatNames[f], String(f)));
      format.value = String(preferredFormat(d));
      const space = document.createElement("select"); space.setAttribute("aria-label", `Space for ${d.name || d.id}`);
      for (const s of d.spaces.length ? d.spaces : [0]) space.add(new Option(spaceNames[s], String(s)));
      space.disabled = d.kind !== 10;
      const value = document.createElement("span"); value.textContent = "Awaiting publication"; value.className = "sample-value numeric";
      for (const item of [check, name, kind, format, space, value]) { const cell = document.createElement("td"); cell.append(item); row.append(cell); }
      tbody.append(row); this.rows.set(index, { row, check, format, space, value });
    });
  }

  get selection(): Selection[] {
    return [...this.rows].filter(([, row]) => row.check.checked).map(([descriptor, row]) => ({ descriptor, format: Number(row.format.value), space: Number(row.space.value) }));
  }

  selectAll(selected: boolean) {
    for (const row of this.rows.values()) row.check.checked = selected;
  }

  update(values: ReadonlyMap<number, CurrentValue>) {
    for (const [index, nodes] of this.rows) {
      const current = values.get(index), d = this.capabilities!.descriptors[index];
      let label = !current ? "Not subscribed" : current.stale ? "Stale · awaiting current data" : valueText(current.value);
      const delta = current?.subscription.deltas.get(current.selection);
      if (delta !== undefined && current?.value !== null && !current?.stale) label += ` · +${delta} ${d.kind === 11 ? "revisions" : "edges"}`;
      if (current && !current.stale && [2,5].includes(d.kind)) for (const field of referenceFields(d.kind)) {
        const counter = d[field] == null ? undefined : values.get(d[field]!);
        const edges = counter?.subscription.deltas.get(counter.selection);
        if (counter && !counter.stale && counter.value !== null && edges !== undefined) label += ` · ${kindNames[this.capabilities!.descriptors[d[field]!].kind]} +${edges}`;
      }
      setText(nodes.value, label);
      setAttribute(nodes.row, "data-available", String(!!current && !current.stale && current.value !== null));
    }

  }
}
customElements.define("sample-selection-table", SampleSelectionTable);
