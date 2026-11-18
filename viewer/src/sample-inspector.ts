import { setAttribute, setText } from "./dom";
import { formatNames, kindNames, spaceNames } from "./protocol";
import type { Session } from "./session";
import { bindingGroups, descriptorLabel, groupName, subscriptionObservations } from "./subscription-editor";

type Field = { value: HTMLElement; status: HTMLElement; slot: number };
export class SampleInspector {
  private readonly select = document.createElement("select");
  private readonly list = document.createElement("div");
  private readonly fields: Field[] = [];
  private topology?: string;
  private shown = "";
  private lastUpdate = -Infinity;

  constructor(host: HTMLElement) {
    const label = document.createElement("label");
    label.className = "inspect-selector";
    label.append("Accepted bundle ", this.select);
    this.list.className = "inspect-list";
    this.list.tabIndex = 0; this.list.setAttribute("aria-label", "Received sample values");
    host.replaceChildren(label, this.list);
  }

  update(session: Session, now: number) {
    const c = session.capabilities!;
    const bundles = [...session.active.values()].flatMap(sub => sub.request.bundles.map((bindings, index) => ({
      sub, bindings, index, key: sub.generation + "/" + index,
    })));
    const topology = bundles.map(b => b.key).join(",");
    if (topology !== this.topology) {
      const previous = this.select.value;
      this.topology = topology;
      this.select.replaceChildren(...bundles.map(({ sub, index, key }) => new Option(
        "#" + sub.request.id + " · " + groupName(c, sub.request.group) + " · Bundle " + index + (index ? " · On change" : " · Every slot"), key)));
      this.select.value = bundles.find(b => b.key === previous)?.key ?? bundles.find(b => b.bindings.length)?.key ?? bundles[0]?.key ?? "";
    }
    const bundle = bundles.find(b => b.key === this.select.value);
    if (!bundle) {
      this.select.disabled = true; this.shown = ""; this.fields.length = 0;
      setText(this.list, "No accepted subscriptions.");
      return;
    }
    this.select.disabled = false;
    if (this.shown !== bundle.key) {
      this.shown = bundle.key; this.fields.length = 0; this.lastUpdate = -Infinity;
      this.list.replaceChildren();
      const field = (slot: number, primary: number) => {
        const binding = bundle.bindings[slot], d = c.descriptors[binding.descriptor];
        const item = document.createElement("div"), label = document.createElement("b");
        const value = document.createElement("span"), meta = document.createElement("small"), status = document.createElement("span");
        const ownerId = c.descriptors[bundle.bindings[primary].descriptor].id;
        const role = d.id === ownerId + "/active" ? "Active" : d.id === ownerId + "/valid" ? "Valid"
          : d.kind === 1 ? descriptorLabel(c, binding.descriptor) : kindNames[d.kind].replaceAll("_", " ");
        label.textContent = primary === slot ? descriptorLabel(c, binding.descriptor) : role;
        label.title = d.id + "\n" + d.description;
        value.className = "sample-value numeric"; status.className = "observed-state";
        meta.textContent = "#" + (slot + 1) + " · " + formatNames[binding.format] + (binding.space ? " · " + spaceNames[binding.space] : "");
        item.dataset.sampleId = d.id;
        item.append(label, value, meta, status);
        this.fields.push({ value, status, slot });
        return item;
      };
      for (const { primary, companions } of bindingGroups(c, bundle.bindings)) {
        const row = document.createElement("div"); row.className = "observed-sample";
        row.append(field(primary, primary));
        const fields = document.createElement("div"); fields.className = "observed-fields";
        for (const slot of companions) fields.append(field(slot, primary));
        if (companions.length) row.append(fields);
        this.list.append(row);
      }
      if (!this.fields.length) setText(this.list, "This bundle has no bindings.");
    }
    if (now - this.lastUpdate < 80) return;
    this.lastUpdate = now;
    const observations = subscriptionObservations(c, bundle.sub, now)[bundle.index];
    for (const { slot, value, status } of this.fields) {
      const observation = observations[slot], raw = observation.value;
      // Preserve full decoded precision, including u64 counters. The editor's compact preview is rounded.
      const exact = Array.isArray(raw) ? raw.join(", ") : raw?.toString() ?? "—";
      setText(value, exact);
      setText(status, [observation.status, observation.delta === undefined ? "" : "Δ " + observation.delta].filter(Boolean).join(" · "));
      setAttribute(value, "title", observation.title || null);
    }
  }
}
