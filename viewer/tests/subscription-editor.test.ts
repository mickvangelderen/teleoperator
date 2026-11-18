import assert from "node:assert/strict";
import { test } from "node:test";
import { Session } from "../src/session";
import { timing, type Capabilities, type Request, type Value } from "../src/protocol";
import { SubscriptionEditorModel, bindingGroups, bindingObservations, companionDescriptors, dirtySubscription, type SubscriptionPort } from "../src/subscription-editor";
import type { PublishResult } from "../src/connection";

const capabilities: Capabilities = { groups: [90, 60], skeletons: [], descriptors: [
  { id: "pose", name: "Pose", description: "", kind: 10, formats: [10, 11], spaces: [2, 3], group: 0, position_valid_sample: 1, orientation_valid_sample: 2 },
  { id: "pose/position_valid", name: "Position valid", description: "", kind: 12, formats: [1], spaces: [], group: 0 },
  { id: "pose/orientation_valid", name: "Orientation valid", description: "", kind: 13, formats: [1], spaces: [], group: 0 },
  { id: "input", name: "Input", description: "", kind: 8, formats: [10, 12], spaces: [], group: 1 },
  { id: "input/active", name: "Active", description: "", kind: 1, formats: [1], spaces: [], group: 1 },
] };
const pose = { descriptor: 0, format: 10, space: 2 };
const valid = [{ descriptor: 1, format: 1, space: 0 }, { descriptor: 2, format: 1, space: 0 }];
const request = (id = 1): Request => ({ id, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: 2, bundles: [[pose, ...valid], [{ ...pose, format: 11, space: 3 }]] });
function setup(r = request()) {
  const session = new Session(); session.receive({ tag: 2, version: 1 }); session.receive({ tag: 3, capabilities: structuredClone(capabilities) });
  session.request(r); session.receive({ tag: 5, id: r.id });
  const calls: { request: Request; automatic?: boolean; previousId?: number }[] = [];
  let next: PublishResult = { kind: "pending", id: 2 };
  const port: SubscriptionPort = { session, isAutomatic: () => false,
    publish(request, automatic, previousId) {
      calls.push({ request: structuredClone(request), automatic, previousId });
      if (next.kind === "pending") session.request({ ...request, id: next.id });
      if (next.kind === "timing") session.changeSchedule(next.id, request);
      return next;
    }, unsubscribe(id) { session.stop(id); } };
  const model = new SubscriptionEditorModel(port);
  return { model, session, entry: model.entries[0], calls, reply: (result: PublishResult) => { next = result; } };
}
function received(session: Session, id: number, bundle: number, values: Value[], timestamp: bigint, arrived: number) {
  const sub = session.active.get(id)!;
  const packet = { id, timestamp, predictedFor: null, sequenceNumber: BigInt(sub.version), bundles: sub.request.bundles.map((_, i) => i === bundle ? values : null) };
  sub.bundles[bundle] = { packet, values, arrivedAt: arrived, acquiredAtArrival: arrived, position: BigInt(sub.version), predictions: [] };
  sub.version++; sub.packet = packet; sub.arrivedAt = arrived;
  if (bundle === 0) sub.acquiredAtArrival = arrived;
}
const position = (x: number) => [x, 1, 2, 0, 0, 0, 1];

test("drafts isolate edits; pending replacement and rejection keep the accepted request and values", () => {
  const { model, session, entry, calls } = setup();
  received(session, 1, 0, [position(1), true, true], 100n, 100);
  const original = structuredClone(session.active.get(1)!.request);
  model.edit(entry, d => { d.delivery = 2; d.bundles[0].bindings[0].format = 11; });
  assert.deepEqual(session.active.get(1)!.request, original);
  const observations = bindingObservations(entry, session, 101);
  assert.equal(observations.get(entry.draft.bundles[0].bindings[0].key)!.status, "Not applied");
  assert.equal(observations.get(entry.draft.bundles[0].bindings[1].key)!.text, "true");
  model.apply(entry);
  assert.equal(calls[0].previousId, 1); assert.equal(entry.pendingId, 2);
  assert.equal(session.active.has(1), true);
  const submitted = structuredClone(entry.draft);
  model.edit(entry, d => { d.bundles[0].bindings = []; });
  assert.deepEqual(entry.draft, submitted, "Pending drafts cannot drift from the request");
  session.receive({ tag: 6, id: 2, reason: "Receiver limit" }); model.sync();
  assert.equal(entry.pendingId, undefined); assert.equal(entry.activeId, 1);
  assert.equal(entry.error, "Receiver limit"); assert.equal(dirtySubscription(entry), true);
  assert.deepEqual(session.active.get(1)!.request, original); assert.deepEqual(entry.draft, submitted);
  model.discard(entry);
  assert.equal(dirtySubscription(entry), false); assert.equal(entry.error, undefined);
  assert.equal(bindingObservations(entry, session, 102).get(entry.draft.bundles[0].bindings[0].key)!.text, "1.000, 1.000, 2.000, 0.000, 0.000, 0.000, 1.000");
});

test("exact duplicate binding slots retain their own format, space, bundle and timestamps", () => {
  const { model, session, entry } = setup();
  received(session, 1, 0, [position(1), true, true], 100n, 100);
  received(session, 1, 1, [position(9)], 80n, 100);
  session.request(request(9)); session.receive({ tag: 5, id: 9 });
  received(session, 9, 0, [position(99), true, true], 200n, 110);
  const values = bindingObservations(entry, session, 120);
  assert.match(values.get(entry.draft.bundles[0].bindings[0].key)!.text, /^1.000/);
  const duplicate = values.get(entry.draft.bundles[1].bindings[0].key)!;
  assert.match(duplicate.text, /^9.000/); assert.equal(duplicate.timestamp, 80n);
  assert.match(duplicate.status, /Retained/); assert.match(duplicate.status, /validity unknown/);
  model.addBindings(entry, entry.draft.bundles[0], [0]);
  assert.equal(bindingObservations(entry, session, 121).get(entry.draft.bundles[0].bindings.at(-1)!.key)!.status, "Not applied");
  model.edit(entry, d => { d.bundles[0].bindings[0].space = 3; });
  assert.equal(bindingObservations(entry, session, 121).get(entry.draft.bundles[0].bindings[0].key)!.status, "Not applied");
  assert.equal(session.active.get(1)!.bundles[0]!.packet.timestamp, 100n);
});

test("mixed omission, repeated cached acquisitions, changed-only silence and termination remain distinct", () => {
  const { session, entry } = setup();
  received(session, 1, 0, [position(1), true, true], 100n, 100);
  received(session, 1, 1, [position(9)], 100n, 100);
  const row = entry.draft.bundles[1].bindings[0].key;
  received(session, 1, 0, [position(2), true, true], 200n, 400);
  assert.equal(bindingObservations(entry, session, 600).get(row)!.status, "Retained · Position validity unknown · Orientation validity unknown");
  assert.equal(bindingObservations(entry, session, 600).get(row)!.timestamp, 100n);
  assert.match(bindingObservations(entry, session, 901).get(row)!.status, /Stale/);
  const changed = setup({ ...request(), bundles: [[], [pose, ...valid]] });
  received(changed.session, 1, 1, [position(3), true, true], 100n, 100);
  const key = changed.entry.draft.bundles[1].bindings[0].key;
  assert.equal(bindingObservations(changed.entry, changed.session, 60_000).get(key)!.status, "Retained");
  assert.equal(bindingObservations(changed.entry, changed.session, 60_000).get(key)!.timestamp, 100n);
  changed.session.receive({ tag: 8, id: 1, reason: "Source ended" }); changed.model.sync();
  assert.equal(bindingObservations(changed.entry, changed.session, 60_001).get(key)!.text, "—");
  assert.equal(changed.entry.error, "Source ended");
});

test("quality requires matching acquisition and preserves false/zero values without claiming validity", () => {
  const { session, entry } = setup();
  received(session, 1, 0, [position(0), false, true], 100n, 100);
  const observation = bindingObservations(entry, session, 110).get(entry.draft.bundles[0].bindings[0].key)!;
  assert.match(observation.text, /^0.000/); assert.equal(observation.status, "Position invalid");
  const inputs = setup({ id: 3, group: 1, delivery: 1, ...timing(60), sequenceNumberFormat: null, bundles: [[{ descriptor: 3, format: 10, space: 0 }, { descriptor: 4, format: 1, space: 0 }]] });
  received(inputs.session, 3, 0, [0, false], 100n, 100);
  const value = bindingObservations(inputs.entry, inputs.session, 101).get(inputs.entry.draft.bundles[0].bindings[0].key)!;
  assert.equal(value.text, "0"); assert.equal(value.status, "Inactive");
});

test("bundle order is explicit, bundle zero can be empty, and change bundles automatically acquire sequences", () => {
  const { model, entry } = setup({ ...request(), sequenceNumberFormat: null, bundles: [[pose, ...valid]] });
  const first = entry.draft.bundles[0].key;
  const second = model.addBundle(entry), third = model.addBundle(entry);
  assert.equal(entry.draft.sequence, 2);
  model.addBindings(entry, second, [0, 0]); assert.equal(second.bindings.length, 2);
  assert.notEqual(second.bindings[0].key, second.bindings[1].key);
  model.moveBundle(entry, 2, -1); assert.equal(entry.draft.bundles[1].key, third.key);
  model.moveBundle(entry, 1, -1); assert.equal(entry.draft.bundles[0].key, first);
  model.removeBundle(entry, 0); assert.equal(entry.draft.bundles[0].key, first);
  model.edit(entry, d => { d.bundles[0].bindings = []; });
  assert.equal(entry.draft.bundles[0].bindings.length, 0);
  model.discard(entry); assert.equal(entry.draft.bundles.length, 1);
  assert.equal(entry.draft.sequence, null);
});

test("independent subscriptions in one group have independent drafts, timing updates and stop", () => {
  const { model, session, entry, calls, reply } = setup();
  const extra = model.create(0); model.addBindings(extra, extra.draft.bundles[0], [0]);
  assert.equal(model.entries.length, 2); assert.equal(extra.group, 0);
  model.apply(extra); assert.equal(calls[0].previousId, undefined);
  session.receive({ tag: 5, id: 2 }); model.sync();
  assert.equal(extra.activeId, 2); assert.equal(entry.activeId, 1);
  received(session, 1, 0, [position(2), true, true], 100n, 100);
  const original = session.active.get(1)!.bundles[0];
  reply({ kind: "timing", id: 1 });
  model.edit(entry, d => { d.interval = 33_333_334n; }); model.apply(entry);
  assert.equal(entry.pendingId, undefined); assert.equal(entry.notice, "Timing sent · no confirmation");
  assert.equal(session.active.get(1)!.bundles[0], original);
  assert.equal(calls.at(-1)!.previousId, 1); assert.equal(extra.activeId, 2);
  model.stop(extra); assert.equal(session.active.has(2), false); assert.equal(session.active.has(1), true);
});

test("companion selection includes typed quality and operator activity, without crossing acquisition groups", () => {
  assert.deepEqual(companionDescriptors(capabilities, 0), [1, 2]);
  assert.deepEqual(companionDescriptors(capabilities, 3), [4]);
  const crossGroup = structuredClone(capabilities); crossGroup.descriptors[1].group = 1;
  assert.deepEqual(companionDescriptors(crossGroup, 0), [2]);
});

test("display groups follow selected relationships within each bundle and retain wire positions", () => {
  const c = structuredClone(capabilities);
  c.descriptors.push({ id: "extra", name: "Other", kind: 1, group: 0, formats: [1], spaces: [], description: "" });
  const groups = (...descriptors: number[]) => bindingGroups(c, descriptors.map(descriptor =>
    ({ descriptor, space: c.descriptors[descriptor].spaces[0] ?? 0, format: c.descriptors[descriptor].formats[0] })));
  assert.deepEqual(groups(1, 5, 0, 2, 1), [{ primary: 1, companions: [] }, { primary: 2, companions: [0, 3, 4] }]);
  assert.deepEqual(groups(3, 4), [{ primary: 0, companions: [1] }]);
  assert.deepEqual(groups(1, 4), [{ primary: 0, companions: [] }, { primary: 1, companions: [] }]);
  // Duplicate owners and distinct owners sharing a reference both leave the field independently editable.
  assert.deepEqual(groups(0, 1, 0), [0, 1, 2].map(primary => ({ primary, companions: [] })));
  c.descriptors.push({ ...c.descriptors[0], id: "second-pose", orientation_valid_sample: null });
  assert.deepEqual(groups(6, 0, 1, 2), [{ primary: 0, companions: [] }, { primary: 1, companions: [3] }, { primary: 2, companions: [] }]);
  c.descriptors.push({ ...c.descriptors[4], group: 0, id: "pose/position_valid/active" });
  assert.deepEqual(groups(7, 0, 1), [{ primary: 1, companions: [0, 2] }]);
});

test("surviving draft identities retain exact applied observations through row and bundle edits", () => {
  const r = request();
  r.bundles = [[pose, ...valid], [{ ...pose, format: 11, space: 3 }, ...valid], [pose, ...valid]];
  const { model, session, entry } = setup(r);
  received(session, 1, 0, [position(1), true, true], 100n, 100);
  received(session, 1, 1, [position(8), true, true], 90n, 100);
  received(session, 1, 2, [position(3), true, true], 80n, 100);
  const firstQuality = entry.draft.bundles[0].bindings[1].key, second = entry.draft.bundles[1].bindings[0].key, third = entry.draft.bundles[2].bindings[0].key;
  model.edit(entry, d => { d.bundles[0].bindings.shift(); d.bundles[1].bindings.reverse(); });
  model.moveBundle(entry, 2, -1);
  const values = bindingObservations(entry, session, 101);
  assert.equal(values.get(firstQuality)!.text, "true", "Removing an earlier row must keep this applied slot visible");
  assert.match(values.get(second)!.text, /^8.000/);
  assert.match(values.get(third)!.text, /^3.000/);
  assert.equal(values.get(second)!.timestamp, 90n); assert.equal(values.get(third)!.timestamp, 80n);
  assert.equal(values.get(second)!.status, "Retained", "Quality follows the applied acquisition, even when the draft order changes");
  received(session, 1, 1, [position(12), true, true], 200n, 120);
  assert.match(bindingObservations(entry, session, 121).get(second)!.text, /^12.000/, "Surviving values keep updating before Apply");
  model.apply(entry);
  session.receive({ tag: 6, id: 2, reason: "Rejected" }); model.sync();
  assert.match(bindingObservations(entry, session, 122).get(second)!.text, /^12.000/);
  model.apply(entry);
  session.receive({ tag: 5, id: 2 }); session.stop(1); model.sync();
  assert.equal(bindingObservations(entry, session, 123).get(second)!.status, "Waiting");
  received(session, 2, 2, [true, true, position(15)], 300n, 130);
  assert.match(bindingObservations(entry, session, 131).get(second)!.text, /^15.000/, "Acceptance switches the same identity to its new applied slot");
});

test("reordered duplicate counters keep their original applied delta offsets", () => {
  const session = new Session();
  const c: Capabilities = { groups: [60], skeletons: [], descriptors: [{ id: "counter", name: "Counter", description: "", kind: 3, formats: [3, 4], group: 0, spaces: [] }] };
  session.receive({ tag: 2, version: 1 }); session.receive({ tag: 3, capabilities: c });
  session.request({ id: 1, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: 2,
    bundles: [[{ descriptor: 0, format: 3, space: 0 }, { descriptor: 0, format: 4, space: 0 }], [{ descriptor: 0, format: 3, space: 0 }]] });
  session.receive({ tag: 5, id: 1 });
  const port: SubscriptionPort = { session, isAutomatic: () => false, publish: () => ({ kind: "error", reason: "Unused" }), unsubscribe() {} };
  const model = new SubscriptionEditorModel(port), entry = model.entries[0];
  received(session, 1, 0, [7, 65543], 100n, 100);
  received(session, 1, 1, [11], 90n, 100);
  const sub = session.active.get(1)!; sub.deltas = new Map([[0, 2n], [1, 5n], [2, 9n]]);
  const keys = entry.draft.bundles.flatMap(b => b.bindings.map(r => r.key));
  model.edit(entry, d => { d.bundles[0].bindings.reverse(); });
  const values = bindingObservations(entry, session, 101);
  assert.equal(values.get(keys[0])!.text, "7 · +2 edges");
  assert.equal(values.get(keys[1])!.text, "65543 · +5 edges");
  assert.equal(values.get(keys[2])!.text, "11 · +9 edges");
});

test("replacing an identical binding remains an applicable draft until its new identity is applied", () => {
  const { model, session, entry, reply } = setup();
  received(session, 1, 0, [position(4), true, true], 100n, 100);
  model.edit(entry, d => { d.bundles[0].bindings.shift(); });
  model.addBindings(entry, entry.draft.bundles[0], [0]);
  model.edit(entry, d => { d.bundles[0].bindings.unshift(d.bundles[0].bindings.pop()!); });
  const key = entry.draft.bundles[0].bindings[0].key;
  assert.equal(dirtySubscription(entry), true, "Identical wire content must not strand a new row as Not applied with Apply disabled");
  assert.equal(bindingObservations(entry, session, 101).get(key)!.status, "Not applied");
  reply({ kind: "timing", id: 1 }); model.apply(entry);
  assert.equal(dirtySubscription(entry), false);
  assert.match(bindingObservations(entry, session, 102).get(key)!.text, /^4.000/);
});
