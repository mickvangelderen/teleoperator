import "./subscription-editor.css";
import { setAttribute, setText } from "../dom";
import { groupColor } from "./graph-style";
import { formatNames, kindNames, publicationRate, spaceNames, timing } from "../protocol";
import { bindingObservations, companionDescriptors, descriptorLabel, dirtySubscription, groupName, SubscriptionEditorModel } from "../subscription-editor";
import type { BundleDraft, EditorSubscription, SubscriptionPort } from "../subscription-editor";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const options = (values: readonly number[], names: string[], selected: number) => values.map(value => '<option value="' + value + '"' + (value === selected ? " selected" : "") + ">" + escape(names[value]) + "</option>").join("");
const button = (action: string, label: string, attrs = "", disabled = false) => '<button type="button" data-action="' + action + '" ' + attrs + (disabled ? " disabled" : "") + ">" + label + "</button>";
type ValueRow = { root: HTMLElement; value: HTMLElement; status: HTMLElement };

export class SubscriptionEditor extends HTMLElement {
  model!: SubscriptionEditorModel;
  private selected?: number;
  private open = new Set<number>();
  private catalogue?: number;
  private query = "";
  private catalogueLimit = 30;
  private companions = true;
  private newVisible = false;
  private newGroup = 0;
  private unit = "Hz";
  private revision = -1;
  private rows = new Map<number, ValueRow>();
  private visible = new Set<number>();
  private observer?: IntersectionObserver;
  private rendering = false;
  private lastValues = "";
  private validation = "";

  constructor() {
    super();
    this.addEventListener("click", event => this.handleClick(event));
    this.addEventListener("input", event => this.input(event));
    this.addEventListener("change", event => this.change(event));
    this.addEventListener("toggle", event => {
      const details = event.target as HTMLDetailsElement;
      if (details.dataset.bundleKey !== undefined) {
        const key = Number(details.dataset.bundleKey);
        if (details.open) this.open.add(key); else this.open.delete(key);
      }
    }, true);
  }
  disconnectedCallback() { this.observer?.disconnect(); }
  configure(port: SubscriptionPort) {
    this.model = new SubscriptionEditorModel(port);
    this.selected = this.model.entries[0]?.key;
    const entry = this.entry;
    entry?.draft.bundles.forEach(b => this.open.add(b.key));
    this.render();
  }
  private get entry() { return this.model.entries.find(e => e.key === this.selected); }
  private entryName(entry: EditorSubscription) {
    const siblings = this.model.entries.filter(e => e.group === entry.group);
    return groupName(this.model.capabilities, entry.group) + (siblings.length > 1 ? " " + (siblings.indexOf(entry) + 1) : "");
  }

  update(now: number) {
    this.model.sync();
    if (this.revision !== this.model.revision) this.render();
    this.updateStatus();
    const entry = this.entry;
    if (!entry) return;
    // Schedule estimates change independently of edits; never replace focused/manual controls.
    if (entry.draft.automatic) this.showTiming(entry);
    const active = entry.activeId === undefined ? undefined : this.model.port.session.active.get(entry.activeId);
    const key = this.model.revision + ":" + active?.version + ":" + this.model.port.session.consumptionTime + ":" + Math.floor(now / 100);
    if (key === this.lastValues) return;
    this.lastValues = key;
    const observations = bindingObservations(entry, this.model.port.session, now);
    for (const index of this.visible) {
      const nodes = this.rows.get(index)!, value = observations.get(index);
      if (!value) continue;
      setText(nodes.value, value.text); setText(nodes.status, value.status);
      setAttribute(nodes.value, "title", value.title || null);
      setAttribute(nodes.root, "data-available", String(value.available));
      setAttribute(nodes.root, "data-acquired-at", value.timestamp?.toString() ?? null);
    }
  }
  private showTiming(entry: EditorSubscription) {
    const fields = { rate: this.unit === "Hz" ? publicationRate(entry.draft).toFixed(1) : (Number(entry.draft.interval) / 1e6).toFixed(3),
      phase: (Number(entry.draft.phase) / 1e6).toFixed(3), predictionOffset: (Number(entry.draft.predictionOffset) / 1e6).toFixed(3) };
    for (const [name, value] of Object.entries(fields)) {
      const input = this.querySelector<HTMLInputElement>('[data-field="' + name + '"]');
      if (input && document.activeElement !== input) input.value = value;
    }
  }
  private status(entry: EditorSubscription) {
    if (entry.error) return "Error" + (entry.activeId === undefined ? "" : " · active");
    if (entry.pendingId !== undefined) return entry.activeId === undefined ? "Starting…" : "Applying…";
    if (dirtySubscription(entry)) return "Draft" + (entry.activeId === undefined ? "" : " · active");
    return entry.activeId === undefined ? "Stopped" : "Active";
  }
  private updateStatus() {
    for (const entry of this.model.entries) {
      const state = this.querySelector<HTMLElement>('[data-entry-status="' + entry.key + '"]');
      if (state) { setText(state, this.status(entry)); setAttribute(state, "data-error", entry.error ? "" : null); }
    }
    const entry = this.entry;
    if (!entry) return;
    const message = this.querySelector<HTMLElement>(".subscription-message")!;
    const active = entry.activeId === undefined ? undefined : this.model.port.session.active.get(entry.activeId);
    const pending = entry.pendingId !== undefined;
    const messageText = this.validation || entry.error || entry.notice || (pending ? (active ? "Applying changes · current subscription continues" : "Starting subscription…") : active ? active.packets + " packets" : "No active publication");
    setText(message, messageText);
    setAttribute(message, "data-tone", this.validation || entry.error ? "error" : null);
    this.querySelector<HTMLButtonElement>('[data-action="apply"]')!.disabled = pending || (!!active && !dirtySubscription(entry)) || !!this.validation;
    this.querySelector<HTMLButtonElement>('[data-action="discard"]')!.disabled = pending || (!dirtySubscription(entry) && !this.validation);
    this.querySelector<HTMLButtonElement>('[data-action="stop"]')!.disabled = pending || !active;
    setText(this.querySelector('[data-action="apply"]')!, pending ? "Applying…" : active ? "Apply" : "Start");
  }
  private render() {
    if (this.rendering) return;
    this.rendering = true;
    this.observer?.disconnect(); this.visible.clear(); this.rows.clear(); this.lastValues = "";
    if (!this.entry) this.selected = this.model.entries[0]?.key;
    const c = this.model.capabilities, entry = this.entry;
    this.innerHTML = '<div class="subscription-layout"><nav class="subscription-navigation" aria-label="Subscriptions"><div class="subscription-list">' +
      this.model.entries.map(e => '<button type="button" data-action="select" data-key="' + e.key + '" data-group="' + e.group + '" style="--group-color:' + groupColor(e.group) + '" aria-pressed="' + (entry === e) + '" title="' + (e.activeId === undefined ? "No active subscription" : "Subscription " + e.activeId) + '"><span class="group-label">' + escape(this.entryName(e)) + '</span><small>Group ' + e.group + ' · <span data-entry-status="' + e.key + '">' + this.status(e) + '</span></small></button>').join("") +
      '</div><div class="new-subscription">' + button("new", "+ New subscription") + (this.newVisible ? '<label>Acquisition group<select data-field="new-group">' + c.groups.map((_, group) => '<option value="' + group + '"' + (group === this.newGroup ? " selected" : "") + '>Group ' + group + ' · ' + escape(groupName(c, group)) + '</option>').join("") + '</select></label>' + button("create", "Create") : "") + '</div></nav><section class="subscription-detail" aria-label="Subscription editor">' +
      (entry ? this.detail(entry) : '<p>Start a subscription to select samples.</p>') + '</section></div>';
    this.revision = this.model.revision;
    this.querySelectorAll<HTMLElement>("[data-binding-key]").forEach(row => {
      this.rows.set(Number(row.dataset.bindingKey), { root: row, value: row.querySelector(".sample-value")!, status: row.querySelector(".binding-state")! });
    });
    this.observer = new IntersectionObserver(entries => {
      for (const observation of entries) {
        const key = Number((observation.target as HTMLElement).dataset.bindingKey);
        if (observation.isIntersecting) this.visible.add(key); else this.visible.delete(key);
      }
      this.lastValues = "";
    });
    for (const row of this.rows.values()) this.observer.observe(row.root);
    this.renderCatalogue();
    this.updateStatus();
    this.rendering = false;
  }
  private detail(entry: EditorSubscription) {
    const d = entry.draft, pending = entry.pendingId !== undefined, c = this.model.capabilities;
    const readOnly = d.automatic ? " readonly" : "", disabled = pending ? " disabled" : "";
    const rate = this.unit === "Hz" ? Number(publicationRate(d).toFixed(3)) : Number(d.interval) / 1e6;
    return '<div class="subscription-heading"><h3>' + escape(this.entryName(entry)) + ' <span>· Group ' + entry.group + '</span></h3><div class="subscription-actions">' + button("discard", "Discard") + button("apply", "Apply", 'class="primary"') + button("stop", "Stop") + '</div></div>' +
      '<div class="subscription-message status-message" role="status"></div>' +
      '<fieldset class="subscription-settings"' + disabled + '><div class="control-row"><label>Delivery<select data-field="delivery" aria-label="Delivery">' + options([1, 2], ["", "Unreliable", "Reliable"], d.delivery) + '</select></label>' +
      '<label><input type="checkbox" data-field="automatic"' + (d.automatic ? " checked" : "") + '> Align to display</label>' +
      '<label>Publication<input type="number" min="0.000001" step="any" required data-field="rate" value="' + rate + '"' + readOnly + ' aria-label="Publication rate or interval"><select data-field="unit" aria-label="Publication timing unit"><option' + (this.unit === "Hz" ? " selected" : "") + '>Hz</option><option' + (this.unit === "ms" ? " selected" : "") + '>ms</option></select></label></div>' +
      '<details class="subscription-timing"><summary>Timing details</summary><div class="control-row"><label>Phase<input type="number" min="0" step="any" required data-field="phase" value="' + Number(d.phase) / 1e6 + '"' + readOnly + ' title="Phase in the server clock, modulo the publication interval"> ms</label>' +
      '<label>Prediction offset<input type="number" min="0" step="any" required data-field="predictionOffset" value="' + Number(d.predictionOffset) / 1e6 + '"' + readOnly + ' title="Requested target offset; the actual device target may be unavailable"> ms</label></div></details></fieldset>' +
      '<div class="bundle-list">' + d.bundles.map((b, index) => this.bundle(entry, b, index)).join("") + '</div>' +
      '<div class="bundle-add">' + button("add-bundle", "+ On-change bundle", "", pending) + '</div>';
  }
  private bundle(entry: EditorSubscription, bundle: BundleDraft, index: number) {
    const pending = entry.pendingId !== undefined, c = this.model.capabilities;
    const attrs = 'data-bundle="' + bundle.key + '"';
    return '<section class="sample-bundle" data-bundle-index="' + index + '"><details data-bundle-key="' + bundle.key + '"' + (this.open.has(bundle.key) ? " open" : "") + '><summary><span>Bundle ' + index + ' · ' + (index === 0 ? "Every slot" : "On change") + '</span><small>' + bundle.bindings.length + ' bindings</small></summary><div class="bundle-body">' +
      '<div class="bundle-actions">' + button("catalogue", "+ Add samples", attrs, pending) + button("clear-bundle", "Clear", attrs, pending || !bundle.bindings.length) +
      (index ? '<span class="bundle-order">' + button("bundle-up", "↑", attrs + ' aria-label="Move Bundle ' + index + ' up"', pending || index === 1) + button("bundle-down", "↓", attrs + ' aria-label="Move Bundle ' + index + ' down"', pending || index === entry.draft.bundles.length - 1) + button("remove-bundle", "Remove bundle", attrs, pending) + '</span>' : "") + '</div>' +
      (this.catalogue === bundle.key ? '<div class="sample-catalogue" aria-label="Sample catalogue"></div>' : "") +
      (bundle.bindings.length ? '<div class="binding-scroll"><table class="binding-table" aria-label="Bundle ' + index + ' sample bindings"><thead><tr><th>Sample</th><th>Current value</th><th>Format</th><th>Space</th><th>Order</th></tr></thead><tbody>' +
      bundle.bindings.map((row, position) => {
        const d = c.descriptors[row.descriptor], name = descriptorLabel(c, row.descriptor), rowAttrs = attrs + ' data-row="' + row.key + '"';
        return '<tr data-binding-key="' + row.key + '" data-descriptor="' + escape(d.id) + '"><td class="binding-name"><span title="' + escape(d.id + "\n" + d.description) + '">' + escape(name) + '</span></td><td class="binding-current"><span class="sample-value numeric">—</span><span class="binding-state"></span></td>' +
          '<td><select data-field="format" ' + rowAttrs + ' aria-label="Format for ' + escape(name) + '"' + (pending ? " disabled" : "") + '>' + options(d.formats, formatNames, row.format) + '</select></td>' +
          '<td>' + (d.kind === 10 ? '<select data-field="space" ' + rowAttrs + ' aria-label="Space for ' + escape(name) + '"' + (pending ? " disabled" : "") + '>' + options(d.spaces, spaceNames, row.space) + '</select>' : '<span class="binding-no-space">—</span>') + '</td><td class="binding-order">' +
          button("row-up", "↑", rowAttrs + ' aria-label="Move ' + escape(name) + ' up"', pending || position === 0) + button("row-down", "↓", rowAttrs + ' aria-label="Move ' + escape(name) + ' down"', pending || position === bundle.bindings.length - 1) + button("row-remove", "×", rowAttrs + ' aria-label="Remove ' + escape(name) + '"', pending) + '</td></tr>';
      }).join("") + '</tbody></table></div>' : '<div class="bundle-empty">' + (index === 0 ? "Empty · only changed bundles will publish" : "Add samples to this bundle") + '</div>') +
      '</div></details></section>';
  }
  private catalogueMatches() {
    const entry = this.entry!, query = this.query.trim().toLowerCase();
    return this.model.capabilities.descriptors.flatMap((d, i) => d.group === entry.group && (d.id + " " + d.name + " " + d.description + " " + kindNames[d.kind]).toLowerCase().includes(query) ? [i] : []);
  }
  private renderCatalogue() {
    const host = this.querySelector<HTMLElement>(".sample-catalogue");
    if (!host) return;
    const c = this.model.capabilities, found = this.catalogueMatches();
    if (!host.firstChild) host.innerHTML = '<div class="catalogue-controls"><label>Find samples<input type="search" data-field="search" placeholder="Name, path or kind" autocomplete="off"></label>' +
      '<label title="Include related quality, activity, counters and revision samples in this bundle"><input type="checkbox" data-field="companions"' + (this.companions ? " checked" : "") + '> Include companions</label>' + button("add-matches", "Add matches") + button("close-catalogue", "Close") + '</div><div class="catalogue-results"></div>';
    const input = host.querySelector<HTMLInputElement>('[data-field="search"]')!;
    if (document.activeElement !== input) input.value = this.query;
    setText(host.querySelector('[data-action="add-matches"]')!, "Add all " + found.length + " matches");
    host.querySelector<HTMLButtonElement>('[data-action="add-matches"]')!.disabled = !found.length || this.entry?.pendingId !== undefined;
    host.querySelector(".catalogue-results")!.innerHTML = found.slice(0, this.catalogueLimit).map(index => {
      const d = c.descriptors[index], companions = companionDescriptors(c, index);
      return '<div class="catalogue-result"><span title="' + escape(d.description + (companions.length ? "\nCompanions: " + companions.map(i => descriptorLabel(c, i)).join(", ") : "")) + '">' + escape(descriptorLabel(c, index)) + '<small>' + escape(d.id) + '</small></span>' + button("add-sample", "Add", 'data-descriptor-index="' + index + '"', this.entry?.pendingId !== undefined) + '</div>';
    }).join("") + (found.length > this.catalogueLimit ? button("more-matches", "Show more") : !found.length ? '<div class="bundle-empty">No matching samples</div>' : "");
  }
  private edited(rebuild = true) {
    if (rebuild) this.render();
    else { this.revision = this.model.revision; this.lastValues = ""; this.updateStatus(); }
  }
  private validateTimingInputs() {
    let invalid = false;
    this.querySelectorAll<HTMLInputElement>('input[data-field="rate"], input[data-field="phase"], input[data-field="predictionOffset"]').forEach(input => {
      const value = input.valueAsNumber;
      const ns = input.dataset.field === "rate" && this.unit === "Hz" ? Math.ceil(1e9 / value) : Math.round(value * 1e6);
      const valid = input.validity.valid && Number.isFinite(value) && Number.isSafeInteger(ns) && ns >= 0 && (input.dataset.field !== "rate" || ns > 0);
      setAttribute(input, "aria-invalid", valid ? null : "true");
      invalid ||= !valid;
    });
    this.validation = invalid ? "Enter a positive publication interval and non-negative timing values." : "";
    return !invalid;
  }
  private input(event: Event) {
    const input = event.target as HTMLInputElement;
    if (this.rendering) return;
    if (input.dataset.field === "search") { this.query = input.value; this.catalogueLimit = 30; this.renderCatalogue(); }
    else if (["rate", "phase", "predictionOffset"].includes(input.dataset.field || "")) this.change(event);
  }
  private change(event: Event) {
    if (this.rendering) return;
    const input = event.target as HTMLInputElement, field = input.dataset.field, entry = this.entry;
    if (!entry || !field) return;
    if (field === "new-group") { this.newGroup = Number(input.value); return; }
    if (field === "companions") { this.companions = input.checked; return; }
    if (field === "unit") { this.unit = input.value; this.showTiming(entry); this.validateTimingInputs(); this.updateStatus(); return; }
    if (field === "search") return;
    if (entry.pendingId !== undefined) return;
    try {
      if (field === "automatic") {
        this.model.edit(entry, d => { d.automatic = input.checked; });
        this.querySelectorAll<HTMLInputElement>('input[data-field="rate"], input[data-field="phase"], input[data-field="predictionOffset"]').forEach(el => el.readOnly = input.checked);
        if (input.checked) this.showTiming(entry);
      } else if (field === "delivery") this.model.edit(entry, d => { d.delivery = Number(input.value); });
      else if (field === "format" || field === "space") {
        const bundle = entry.draft.bundles.find(b => b.key === Number(input.dataset.bundle))!;
        this.model.edit(entry, () => { bundle.bindings.find(r => r.key === Number(input.dataset.row))![field] = Number(input.value); });
      } else {
        const value = input.valueAsNumber;
        const ns = field === "rate" && this.unit === "Hz" ? Math.ceil(1e9 / value) : Math.round(value * 1e6);
        if (!input.validity.valid || !Number.isFinite(value) || !Number.isSafeInteger(ns) || ns < 0 || (field === "rate" && ns === 0)) throw new Error("Enter a positive publication interval and non-negative timing values.");
        this.model.edit(entry, d => {
          if (field === "rate") d.interval = this.unit === "Hz" ? timing(value).interval : BigInt(ns);
          else if (field === "phase" || field === "predictionOffset") d[field] = BigInt(ns);
        });
      }
    } catch (error) { this.validation = (error as Error).message; setAttribute(input, "aria-invalid", "true"); }
    this.validateTimingInputs();
    this.edited(false);
  }
  private handleClick(event: Event) {
    const target = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
    if (!target || target.disabled || !this.model) return;
    const action = target.dataset.action, entry = this.entry;
    if (action === "new") { this.newVisible = !this.newVisible; this.render(); return; }
    if (action === "create") {
      const created = this.model.create(this.newGroup); this.selected = created.key; this.catalogue = undefined; this.validation = "";
      created.draft.bundles.forEach(b => this.open.add(b.key)); this.newVisible = false; this.render(); return;
    }
    if (action === "select") { this.selected = Number(target.dataset.key); this.catalogue = undefined; this.validation = ""; this.unit = "Hz"; this.entry?.draft.bundles.forEach(b => this.open.add(b.key)); this.render(); return; }
    if (!entry) return;
    const bundle = entry.draft.bundles.find(b => b.key === Number(target.dataset.bundle));
    const index = bundle ? entry.draft.bundles.indexOf(bundle) : -1;
    if (action === "apply") { if (this.validateTimingInputs()) this.model.apply(entry); }
    else if (action === "discard") { this.model.discard(entry); this.validation = ""; this.catalogue = undefined; }
    else if (action === "stop") this.model.stop(entry);
    else if (action === "add-bundle") { const b = this.model.addBundle(entry); this.open.add(b.key); }
    else if (action === "remove-bundle") this.model.removeBundle(entry, index);
    else if (action === "bundle-up" || action === "bundle-down") this.model.moveBundle(entry, index, action === "bundle-up" ? -1 : 1);
    else if (action === "clear-bundle") this.model.edit(entry, () => { bundle!.bindings = []; });
    else if (action === "catalogue") { this.catalogue = bundle!.key; this.query = ""; this.catalogueLimit = 30; }
    else if (action === "close-catalogue") this.catalogue = undefined;
    else if (action === "more-matches") { this.catalogueLimit += 30; this.renderCatalogue(); return; }
    else if (action === "add-sample" || action === "add-matches") {
      const indices = action === "add-matches" ? this.catalogueMatches() : [Number(target.dataset.descriptorIndex)];
      const selected = this.companions ? [...new Set(indices.flatMap(i => [i, ...companionDescriptors(this.model.capabilities, i)]))] : indices;
      const destination = entry.draft.bundles.find(b => b.key === this.catalogue)!;
      this.model.addBindings(entry, destination, selected);
    } else if (action?.startsWith("row-")) {
      const position = bundle!.bindings.findIndex(r => r.key === Number(target.dataset.row));
      this.model.edit(entry, () => {
        if (action === "row-remove") bundle!.bindings.splice(position, 1);
        else {
          const next = position + (action === "row-up" ? -1 : 1);
          if (next >= 0 && next < bundle!.bindings.length) [bundle!.bindings[position], bundle!.bindings[next]] = [bundle!.bindings[next], bundle!.bindings[position]];
        }
      });
    }
    this.edited();
    if (action === "catalogue") this.querySelector<HTMLInputElement>('[data-field="search"]')?.focus();
  }
}
customElements.define("subscription-editor", SubscriptionEditor);
