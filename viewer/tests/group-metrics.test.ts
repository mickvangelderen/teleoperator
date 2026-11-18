import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupMetrics } from "../src/group-metrics";
import { Session } from "../src/session";
import type { Request, Packet } from "../src/protocol";
import { timing } from "../src/protocol";
import { setClock } from "./clock-fixture";

const ns = (ms: number) => BigInt(Math.round(ms * 1e6));
function session() {
  const s = new Session(); s.receive({ tag: 2, version: 1 });
  s.receive({ tag: 3, capabilities: { groups: [200, 200, 200], skeletons: [{ joints: [{ parent: 0, pose_sample: 0, rest_pose_sample: 2 }] }], descriptors: [
    { id: "pose", name: "Pose", description: "", group: 0, kind: 10, formats: [10], spaces: [2] },
    { id: "button", name: "Button", description: "", group: 1, kind: 2, formats: [1], spaces: [] },
    { id: "rest", name: "Rest", description: "", group: 2, kind: 10, formats: [10], spaces: [5] },
  ] } });
  setClock(s, { offset: 0n, delay: 100_000n, at: 0 }); return s;
}
function subscribe(s: Session, id: number, group: number, changed = false, samples = 1) {
  const descriptor = s.capabilities!.descriptors[group];
  const bindings = Array.from({ length: samples }, () => ({ descriptor: group, format: descriptor.formats[0], space: descriptor.spaces[0] ?? 0 }));
  const request: Request = { id, group, delivery: 1, ...timing(60), sequenceNumberFormat: changed ? 2 : null, bundles: changed ? [[], bindings] : [bindings] };
  s.request(request); s.receive({ tag: 5, id }); return s.active.get(id)!;
}
// Metric fixtures specify already accepted/consumed snapshots, without deriving
// expected aggregates from the implementation under test.
function sample(s: Session, id: number, acquired: number, arrived: number, target: number | null = null) {
  const sub = s.active.get(id)!, index = sub.request.bundles[0].length ? 0 : 1;
  const values = sub.request.bundles[index].map(() => sub.request.group === 1 ? true : [0, 0, 0, 0, 0, 0, 1]);
  const packet: Packet = { id, timestamp: ns(acquired), predictedFor: target === null ? null : ns(target), sequenceNumber: sub.request.sequenceNumberFormat === null ? null : 0n, bundles: index ? [[], values] : [values] };
  sub.bundles[index] = { packet, values, arrivedAt: arrived, acquiredAtArrival: arrived, position: ns(acquired), predictions: [] };
  sub.acquiredAtArrival = arrived;
}

test("group summaries include inputs and give groups equal weight despite sample/subscription counts", () => {
  const s = session(); const a = subscribe(s, 1, 0, false, 70), b = subscribe(s, 2, 1), extra = subscribe(s, 3, 0);
  sample(s, 1, 980, 1000); sample(s, 2, 960, 1000); sample(s, 3, 990, 1000);
  // Seventy same-time pose bindings must not outweigh the input-only group.
  a.arrivals = Array(60).fill(1000); extra.arrivals = Array(20).fill(1000); b.arrivals = Array(40).fill(1000);
  const result = new GroupMetrics().update(s, 1000, 0);
  assert.deepEqual(result.groups.map(g => [g.age, g.arrival]), [[20, 80], [40, 40]]);
  assert.equal(result.age, 30); assert.equal(result.arrival, 60);
  assert.ok(Math.abs(result.groups[0].requested! - 120) < 0.001, "Requested message rates sum within the group too");
});

test("headline is the mean of group medians, while raw traces retain staggered spikes", () => {
  const s = session(), metrics = new GroupMetrics(); subscribe(s, 1, 0); subscribe(s, 2, 1);
  const values = [[0, 100], [100, 0], [100, 100]];
  let result;
  values.forEach(([a, b], i) => {
    const now = 1000 + i * 100;
    sample(s, 1, now - a, now); sample(s, 2, now - b, now);
    s.active.get(1)!.arrivals = Array(a).fill(now); s.active.get(2)!.arrivals = Array(b).fill(now);
    result = metrics.update(s, now, 0);
    assert.deepEqual(result.groups.map(g => [g.age, g.arrival]), [[a, a], [b, b]], "Graph inputs remain unsmoothed");
  });
  assert.equal(result!.age, 100); assert.equal(result!.arrival, 100, "Median of the aggregate would incorrectly be 50");
  sample(s, 1, 1300, 1300); sample(s, 2, 1300, 1300);
  result = metrics.update(s, 3300, 0);
  assert.equal(result.age, undefined, "Stale snapshots cannot contribute an age");
  assert.equal(result.arrival, 0, "Silence is zero arrivals, not a missing value");
  sample(s, 1, 3290, 3300); sample(s, 2, 3270, 3300);
  result = metrics.update(s, 3300, 0); assert.equal(result.age, 20, "Missing data clears old median history");
});

test("rest and changed-only subscriptions retain arrival traces but never dilute continuous headlines", () => {
  const s = session(), metrics = new GroupMetrics(); subscribe(s, 1, 0); const changed = subscribe(s, 2, 1, true), rest = subscribe(s, 3, 2);
  sample(s, 1, 980, 1000); sample(s, 2, 0, 0); sample(s, 3, 0, 0);
  s.active.get(1)!.arrivals = Array(60).fill(1000); changed.arrivals = [1000]; rest.arrivals = [1000];
  const result = metrics.update(s, 1000, 0);
  assert.equal(result.groups.length, 3); assert.equal(result.age, 20); assert.equal(result.arrival, 60);
  assert.deepEqual(result.groups.map(g => g.continuous), [true, false, false]);
  s.stop(1); const retained = metrics.update(s, 1001, 0);
  assert.equal(retained.age, undefined); assert.equal(retained.arrival, undefined);
  assert.equal(retained.groups.length, 2);
});

test("continuous and changed-only streams in one group contribute arrivals once and only continuous age", () => {
  const s = session(), metrics = new GroupMetrics();
  const continuous = subscribe(s, 1, 0), changed = subscribe(s, 2, 0, true), input = subscribe(s, 3, 1);
  sample(s, 1, 980, 1000); sample(s, 2, 0, 0); sample(s, 3, 960, 1000);
  continuous.arrivals = Array(60).fill(1000); changed.arrivals = Array(10).fill(1000); input.arrivals = Array(30).fill(1000);
  const result = metrics.update(s, 1000, 0);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups.map(g => [g.group, g.arrival, g.age]), [[0, 70, 20], [1, 30, 40]]);
  assert.equal(result.arrival, 50); assert.equal(result.age, 30);
  assert.equal(changed.bundles[1]!.packet.timestamp, 0n, "Retained timestamps remain unchanged");
  s.stop(1);
  const retainedOnly = metrics.update(s, 1000, 0);
  assert.equal(retainedOnly.arrival, 30); assert.equal(retainedOnly.age, 40);
  assert.equal(retainedOnly.groups[0].arrival, 10, "Changed-only arrivals remain visible after leaving the headline");
});

test("missing, stale or clockless members make the age unknown without hiding known traces", () => {
  const s = session(), metrics = new GroupMetrics(); subscribe(s, 1, 0); subscribe(s, 2, 1);
  sample(s, 1, 980, 1000);
  let result = metrics.update(s, 1000, 0);
  assert.equal(result.age, undefined); assert.equal(result.groups[0].age, 20); assert.equal(result.groups[1].age, undefined);
  sample(s, 2, 980, 0); assert.equal(metrics.update(s, 1000, 0).age, undefined);
  sample(s, 2, 960, 1000); assert.equal(metrics.update(s, 1000, 0).age, 30);
  setClock(s, undefined); assert.equal(metrics.update(s, 1000, 0).age, undefined);
  setClock(s, { offset: 0n, delay: 100_000n, at: 0 });
  assert.equal(metrics.update(s, 30001, 0).age, undefined);
});

test("consumed prediction timestamps and original acquisitions remain authoritative", () => {
  const s = session(), metrics = new GroupMetrics(); const sub = subscribe(s, 1, 0);
  sample(s, 1, 980, 1000, 1010);
  const snapshot = sub.bundles[0]!, timestamp = snapshot.packet.timestamp;
  const later = { ...snapshot, packet: { ...snapshot.packet, predictedFor: ns(1100) } };
  sub.bundles[0] = { ...later, consumed: snapshot };
  assert.equal(metrics.update(s, 1000, 0).age, -10, "Use the consumed target rather than the newest received target");
  assert.equal(metrics.update(s, 1000, 20).age, 10, "Changing photon assumption resets age history immediately");
  assert.equal(metrics.update(s, 1000, 0).age, -10);
  for (let now = 1100; now <= 1600; now += 100) {
    sub.arrivals.push(now); sub.bundles[0]!.arrivedAt = now;
    metrics.update(s, now, 0);
  }
  assert.equal(metrics.update(s, 1600, 0).age, undefined, "Repeated deliveries cannot refresh the source acquisition");
  assert.equal(snapshot.packet.timestamp, timestamp); assert.equal(snapshot.acquiredAtArrival, 1000);
});

test("replacement, membership changes and disconnect reset only the affected group histories", () => {
  const s = session(), metrics = new GroupMetrics(); subscribe(s, 1, 0); subscribe(s, 2, 1);
  for (let now = 1000; now <= 1100; now += 50) { sample(s, 1, now - 100, now); sample(s, 2, now - 40, now); metrics.update(s, now, 0); }
  const oldKey = metrics.update(s, 1100, 0).groups[0].key;
  subscribe(s, 1, 0); sample(s, 1, 1190, 1200); sample(s, 2, 1200, 1200);
  let result = metrics.update(s, 1200, 0);
  assert.notEqual(result.groups[0].key, oldKey); assert.equal(result.age, 25);
  subscribe(s, 3, 0); result = metrics.update(s, 1200, 0); assert.equal(result.age, undefined);
  s.stop(3); result = metrics.update(s, 1200, 0); assert.equal(result.groups[0].medianAge, 10);
  s.stop(1); assert.equal(metrics.update(s, 1200, 0).groups.length, 1);
  s.retire(); assert.deepEqual(metrics.update(s, 1201, 0), { groups: [], arrival: undefined, age: undefined });
});
