import type { Capabilities, Request, Selection, Timing, Value } from "./protocol";
import { kindNames, preferredFormat, referenceFields, restGroup, timing } from "./protocol";
import type { PublishResult } from "./connection";
import { selectedBundle, type Session } from "./session";
import { staleBundle, valueText } from "./tracking-view";

export type BindingDraft = Selection & { key: number };
export type BundleDraft = { key: number; bindings: BindingDraft[] };
export type SubscriptionDraft = Timing & {
  delivery: number; automatic: boolean; sequence: Request["sequenceNumberFormat"]; bundles: BundleDraft[];
};
export type EditorSubscription = {
  key: number; group: number; draft: SubscriptionDraft; applied: SubscriptionDraft;
  activeId?: number; pendingId?: number; submitted?: SubscriptionDraft;
  error?: string; notice?: string;
};
export interface SubscriptionPort {
  readonly session: Session;
  isAutomatic(id: number): boolean;
  publish(request: Request, automatic?: boolean, previousId?: number): PublishResult;
  unsubscribe(id: number): void;
}
const copy = <T>(value: T): T => structuredClone(value);
export const sameBinding = (a: Selection, b: Selection) => a.descriptor === b.descriptor && a.format === b.format && a.space === b.space;
const wireBundles = (draft: SubscriptionDraft) => draft.bundles.map(b => b.bindings.map(({ descriptor, format, space }) => ({ descriptor, format, space })));
export function sameDraft(a: SubscriptionDraft, b: SubscriptionDraft) {
  return a.delivery === b.delivery && a.automatic === b.automatic && a.sequence === b.sequence
    && (a.automatic || (a.interval === b.interval && a.phase === b.phase && a.predictionOffset === b.predictionOffset))
    && JSON.stringify(a.bundles) === JSON.stringify(b.bundles);
}
export const dirtySubscription = (entry: EditorSubscription) => !sameDraft(entry.draft, entry.applied);

export function groupName(c: Capabilities, group: number) {
  if (restGroup(c, group)) return "Rest skeleton";
  const descriptors = c.descriptors.filter(d => d.group === group);
  if (descriptors.some(d => d.id.startsWith("/body/"))) return "Body tracking";
  if (descriptors.some(d => d.kind === 10)) return "Poses";
  if (descriptors.some(d => d.kind >= 2 && d.kind <= 9)) return "Inputs";
  return "Samples";
}

// Explicit catalogue additions; the wire itself never adds companion bindings.
export function companionDescriptors(c: Capabilities, index: number): number[] {
  const group = c.descriptors[index].group, found = new Set<number>(), queue = [index];
  const add = (i: number | null | undefined) => {
    if (i == null || i === index || found.has(i) || c.descriptors[i]?.group !== group) return;
    found.add(i); queue.push(i);
  };
  while (queue.length) {
    const d = c.descriptors[queue.shift()!];
    for (const field of referenceFields(d.kind)) add(d[field]);
    for (const suffix of ["/active", "/valid"]) {
      const i = c.descriptors.findIndex(x => x.id === d.id + suffix && x.kind === 1 && x.formats.includes(1));
      if (i >= 0) add(i);
    }
    if (d.kind === 10) {
      const targets = new Set(c.skeletons.flatMap(s => s.joints.filter(j => c.descriptors[j.pose_sample] === d || c.descriptors[j.rest_pose_sample] === d).map(j => c.descriptors[j.rest_pose_sample].group)));
      c.descriptors.forEach((r, i) => { if (r.kind === 11 && r.revision_of !== undefined && targets.has(r.revision_of)) add(i); });
    }
  }
  return [...found];
}

/** Drafts and local row identities only. Session remains the source of accepted requests and received data. */
export class SubscriptionEditorModel {
  readonly entries: EditorSubscription[] = [];
  revision = 0;
  private nextKey = 1;
  constructor(readonly port: SubscriptionPort) { this.sync(); }
  get capabilities() { return this.port.session.capabilities!; }
  private binding(selection: Selection): BindingDraft { return { ...selection, key: this.nextKey++ }; }
  private fromRequest(r: Request, automatic: boolean): SubscriptionDraft {
    return { delivery: r.delivery, interval: r.interval, phase: r.phase, predictionOffset: r.predictionOffset, sequence: r.sequenceNumberFormat, automatic,
      bundles: r.bundles.map(b => ({ key: this.nextKey++, bindings: b.map(s => this.binding(s)) })) };
  }
  sync() {
    const session = this.port.session;
    for (const entry of this.entries) {
      if (entry.pendingId !== undefined && !session.pending.has(entry.pendingId)) {
        const accepted = session.active.get(entry.pendingId), outcome = session.outcomes.get(entry.pendingId);
        if (accepted) {
          entry.activeId = entry.pendingId;
          entry.applied = copy(entry.submitted!); entry.draft = copy(entry.applied);
          entry.error = undefined; entry.notice = undefined;
        } else entry.error = outcome?.reason || (outcome?.status === "ended" ? "Subscription ended before publication." : "Subscription rejected.");
        entry.pendingId = undefined; entry.submitted = undefined; this.revision++;
      }
      if (entry.activeId !== undefined && !session.active.has(entry.activeId)) {
        const outcome = session.outcomes.get(entry.activeId);
        entry.activeId = undefined;
        if (outcome?.status === "ended") entry.error = outcome.reason || "Subscription ended.";
        this.revision++;
      }
      const active = entry.activeId === undefined ? undefined : session.active.get(entry.activeId);
      if (active) {
        const clean = !dirtySubscription(entry);
        for (const field of ["interval", "phase", "predictionOffset"] as const) {
          entry.applied[field] = active.request[field];
          if (clean || entry.draft.automatic) entry.draft[field] = active.request[field];
        }
      }
    }
    const known = new Set(this.entries.flatMap(e => [e.activeId, e.pendingId]));
    for (const [id, request] of [...session.active].map(([id, sub]) => [id, sub.request] as const).concat([...session.pending])) {
      if (known.has(id)) continue;
      const draft = this.fromRequest(request, this.port.isAutomatic(id));
      const pending = session.pending.has(id);
      this.entries.push({ key: this.nextKey++, group: request.group, draft, applied: copy(draft),
        activeId: pending ? undefined : id, pendingId: pending ? id : undefined, submitted: pending ? copy(draft) : undefined });
      known.add(id); this.revision++;
    }
  }
  create(group: number) {
    if (!Number.isInteger(group) || group < 0 || group >= this.capabilities.groups.length) throw new Error("Unknown acquisition group");
    const rest = restGroup(this.capabilities, group);
    const draft: SubscriptionDraft = { ...timing(Math.min(this.capabilities.groups[group], 60)), delivery: rest ? 2 : 1, automatic: !rest, sequence: null,
      bundles: [{ key: this.nextKey++, bindings: [] }] };
    if (rest) { draft.bundles.push({ key: this.nextKey++, bindings: [] }); draft.sequence = 2; }
    const entry: EditorSubscription = { key: this.nextKey++, group, draft, applied: copy(draft) };
    this.entries.push(entry); this.revision++; return entry;
  }
  edit(entry: EditorSubscription, update: (draft: SubscriptionDraft) => void) {
    if (entry.pendingId !== undefined) return;
    update(entry.draft);
    if (entry.draft.bundles.length > 1 && entry.draft.sequence === null) entry.draft.sequence = 2;
    entry.error = undefined; entry.notice = undefined; this.revision++;
  }
  addBundle(entry: EditorSubscription) {
    const bundle: BundleDraft = { key: this.nextKey++, bindings: [] };
    this.edit(entry, d => d.bundles.push(bundle)); return bundle;
  }
  removeBundle(entry: EditorSubscription, index: number) { if (index > 0) this.edit(entry, d => d.bundles.splice(index, 1)); }
  moveBundle(entry: EditorSubscription, index: number, direction: number) {
    const next = index + direction;
    if (index < 1 || next < 1 || next >= entry.draft.bundles.length) return;
    this.edit(entry, d => { [d.bundles[index], d.bundles[next]] = [d.bundles[next], d.bundles[index]]; });
  }
  addBindings(entry: EditorSubscription, bundle: BundleDraft, descriptors: number[]) {
    const selections = descriptors.map(descriptor => {
      const d = this.capabilities.descriptors[descriptor];
      if (!d || d.group !== entry.group) throw new Error("Samples must belong to this acquisition group");
      return this.binding({ descriptor, format: preferredFormat(d), space: d.spaces[0] ?? 0 });
    });
    this.edit(entry, () => bundle.bindings.push(...selections));
  }
  discard(entry: EditorSubscription) {
    if (entry.pendingId !== undefined) return;
    entry.draft = copy(entry.applied); entry.error = undefined; entry.notice = undefined; this.revision++;
  }
  apply(entry: EditorSubscription) {
    if (entry.pendingId !== undefined) return;
    const d = entry.draft;
    const request: Request = { id: 0, group: entry.group, delivery: d.delivery, interval: d.interval, phase: d.phase, predictionOffset: d.predictionOffset,
      sequenceNumberFormat: d.bundles.length > 1 ? d.sequence ?? 2 : d.sequence, bundles: wireBundles(d) };
    const result = this.port.publish(request, d.automatic, entry.activeId);
    if (result.kind === "error") entry.error = result.reason;
    else if (result.kind === "timing") {
      entry.applied = copy(d); entry.notice = "Timing sent · no confirmation"; entry.error = undefined;
    } else {
      entry.pendingId = result.id; entry.submitted = copy(d); entry.error = undefined; entry.notice = undefined;
    }
    this.revision++;
  }
  stop(entry: EditorSubscription) {
    if (entry.pendingId !== undefined || entry.activeId === undefined) return;
    this.port.unsubscribe(entry.activeId); entry.activeId = undefined; entry.notice = "Stopped"; entry.error = undefined; this.revision++;
  }
}

export type BindingObservation = { text: string; status: string; title: string; available: boolean; timestamp?: bigint };
const unavailable = (status: string): BindingObservation => ({ text: "—", status, title: "", available: false });

/** Exact accepted slots: descriptor-global display arbitration must never feed an editor row. */
export function bindingObservations(entry: EditorSubscription, session: Session, now: number) {
  const result = new Map<number, BindingObservation>(), sub = entry.activeId === undefined ? undefined : session.active.get(entry.activeId);
  const c = session.capabilities!;
  const qualifiers = new Map<number, { value: Value; timestamp: bigint; stale: boolean }[]>();
  if (sub) sub.request.bundles.forEach((bundle, index) => {
    const received = selectedBundle(sub, index);
    if (!received) return;
    const stale = staleBundle(sub, index, now, restGroup(c, entry.group));
    bundle.forEach((selection, slot) => {
      const existing = qualifiers.get(selection.descriptor) ?? [];
      existing.push({ value: received.values[slot], timestamp: received.packet.timestamp, stale });
      qualifiers.set(selection.descriptor, existing);
    });
  });
  let flat = 0;
  const appliedBundles = new Map(entry.applied.bundles.map((bundle, index) => {
    const location = { index, flat, bindings: new Map(bundle.bindings.map((row, slot) => [row.key, { row, slot }])) };
    flat += bundle.bindings.length;
    return [bundle.key, location] as const;
  }));
  entry.draft.bundles.forEach(bundle => {
    const location = appliedBundles.get(bundle.key);
    bundle.bindings.forEach(row => {
      const applied = location?.bindings.get(row.key), d = c.descriptors[row.descriptor];
      if (!location || !applied || !sameBinding(applied.row, row)) { result.set(row.key, unavailable("Not applied")); return; }
      const { index, flat } = location, { slot } = applied;
      if (!sub) { result.set(row.key, unavailable(entry.pendingId === undefined ? "Stopped" : "Waiting")); return; }
      const received = selectedBundle(sub, index);
      if (!received) { result.set(row.key, unavailable("Waiting")); return; }
      const value = received.values[slot], packet = received.packet;
      if (value === undefined) { result.set(row.key, unavailable("Missing")); return; }
      const stale = staleBundle(sub, index, now, restGroup(c, entry.group));
      const statuses: string[] = [];
      if (stale) statuses.push("Stale");
      else if (index > 0 || restGroup(c, entry.group)) statuses.push("Retained");
      const quality = (descriptor: number | null | undefined) => {
        if (descriptor == null) return undefined;
        const matching = qualifiers.get(descriptor)?.filter(q => !q.stale && q.timestamp === packet.timestamp);
        return matching?.length && matching.every(q => q.value === matching[0].value) ? matching[0].value : undefined;
      };
      if (!stale && d.kind === 10) {
        for (const [field, label] of [["position_valid_sample", "Position"], ["orientation_valid_sample", "Orientation"]] as const) {
          if (d[field] == null) continue;
          const valid = quality(d[field]);
          if (valid !== true) statuses.push(valid === false ? label + " invalid" : label + " validity unknown");
        }
      }
      const companion = c.descriptors.findIndex(x => x.group === d.group && x.kind === 1 && x.formats.includes(1) && x.id === d.id + (d.kind === 16 ? "/valid" : "/active"));
      if (!stale && companion >= 0) {
        const valid = quality(companion);
        if (valid !== true) statuses.push(valid === false ? (d.kind === 16 ? "Invalid" : "Inactive") : "Validity unknown");
      }
      const delta = sub.deltas.get(flat + slot);
      const text = valueText(value) + (delta === undefined || stale ? "" : " · +" + delta + (d.kind === 11 ? " revisions" : " edges"));
      const title = "Acquired " + packet.timestamp + " ns" + (packet.predictedFor === null ? "" : "; actual target " + packet.predictedFor + " ns") + "." + (index > 0 ? " Retained data keeps its original acquisition time; silence alone does not establish connection health." : "");
      result.set(row.key, { text, status: statuses.join(" · "), title, available: !stale, timestamp: packet.timestamp });
    });
  });
  return result;
}
export const descriptorLabel = (c: Capabilities, index: number) => c.descriptors[index].name || c.descriptors[index].id || kindNames[c.descriptors[index].kind];
