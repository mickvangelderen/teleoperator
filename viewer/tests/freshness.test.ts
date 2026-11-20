import { setClock } from "./clock-fixture";
import { timing, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { GroupMetrics } from "../src/group-metrics";
import { FreshnessBaseline } from "../src/freshness";
import { Session } from "../src/session";

function session(rate = 100, delivery = 1) {
  const s = new Session();
  s.receive({ tag: 2, version: 1 });
  s.receive({ tag: 3, capabilities: { groups: [200], skeletons: [], descriptors: [
    { id: "button", name: "Button", description: "", kind: 2, formats: [1], spaces: [], group: 0 },
  ] } });
  s.request({ id: 1, group: 0, delivery, ...timing(rate), sequenceNumberFormat: null, bundles: [[{ descriptor: 0, format: 1, space: 0 }]]});
  s.receive({ tag: 5, id: 1 });
  setClock(s, { offset: 9_007_199_254_740_993n, delay: 20_000_000n, at: 1000 });
  return s;
}
function packet(s: Session, acquired: number, arrived: number, id = 1) {
  const bytes = Buffer.alloc(21);
  bytes.writeUInt32LE(id); bytes.writeBigUInt64LE(NON_MAX, 12);
  bytes.writeBigUInt64LE(9_007_199_254_740_993n + BigInt(Math.round(acquired * 1e6)), 4);
  bytes[20] = 1;
  return s.tracking(bytes, arrived, s.active.get(id)!.request.delivery);
}

test("delivery time stays fixed until the next acquisition or a stall", () => {
  const s = session();
  assert.equal(s.freshness(1000).status, "Unknown");
  assert.ok(packet(s, 1000, 1010));
  assert.equal(s.freshness(1010).status, "Fresh");
  assert.equal(s.freshness(1030).status, "Fresh");
  assert.equal(s.freshness(1030.001).status, "Fresh");
  assert.equal(s.freshness(1410).worst!.ageMs, 10);
  assert.equal(s.freshness(1410).worst!.thresholdMs, 30);
  assert.ok(packet(s, 1400, 1410));
  assert.equal(s.freshness(1410).status, "Fresh");
});

test("delivery health, frame freshness and represented image age use independent endpoints", () => {
  const s = session(), origin = 9_007_199_254_740_993n;
  setClock(s, { offset: origin, delay: 2_000_000n, at: 0 });
  const bytes = Buffer.alloc(21);
  bytes.writeUInt32LE(1);
  bytes.writeBigUInt64LE(origin + 174_000_000n, 4);
  bytes.writeBigUInt64LE(origin + 100_000_000n, 12);
  bytes[20] = 1;
  // Socket callback at 175, decoded sample available at 177, frame use at 180.
  assert.ok(s.tracking(bytes, 175, 1, () => 177));
  s.consume(180, 20);
  const metrics = new GroupMetrics();
  assert.equal(s.freshness(180).worst?.ageMs, 3);
  assert.equal(s.freshness(180).status, "Fresh");
  assert.equal(metrics.update(s, 180, 20).groups[0].age, 100);
  assert.equal(metrics.update(s, 180, 20).groups[0].freshness, 6);
  assert.ok(s.tracking(bytes, 195, 1, () => 197));
  s.consume(200);
  assert.equal(s.freshness(200).worst?.ageMs, 3);
  assert.equal(metrics.update(s, 200).groups[0].age, 100);
  assert.equal(metrics.update(s, 200).groups[0].freshness, 26);
});

test("a queue of old packets cannot recover freshness or raise its own threshold", () => {
  for (const delivery of [1, 2]) {
    const s = session(100, delivery);
    packet(s, 1000, 1010);
    for (let n = 1; n <= 300; n++) {
      packet(s, 1000 + n * 10, 1410 + n * 10);
      assert.equal(s.freshness(1410 + n * 10).status, "Late");
      assert.equal(s.freshness(1410 + n * 10).worst!.thresholdMs, 30);
    }
    assert.equal(packet(s, 1000, 5000), null, "Out-of-order samples are not accepted");
    assert.equal(s.freshness(5000).status, "Stalled");
  }
  const first = session(); packet(first, 1000, 1410);
  assert.equal(first.freshness(1410).status, "Late", "The first stale packet is checked against the probe baseline");
});

test("threshold uses two-second median latency, two intervals, and robust jitter", () => {
  const baseline = new FreshnessBaseline();
  for (const [i, age] of [8, 9, 10, 11, 12].entries()) baseline.observe(age, 1000 + i * 100, 10, 10);
  assert.equal(baseline.latencyMs, 10);
  assert.equal(baseline.jitterMs, 3);
  assert.equal(baseline.thresholdMs, 33);
  baseline.observe(25, 1500, 10, 10);
  assert.equal(baseline.latencyMs, 10.5, "A brief latency spike does not replace the median");
  baseline.observe(20, 3500, 10, 10);
  assert.equal(baseline.thresholdMs, 40, "Old measurements expire at two seconds");
  const slow = session(10); packet(slow, 1000, 1010);
  assert.equal(slow.freshness(1210).status, "Fresh");
  assert.equal(slow.freshness(1211).status, "Fresh");
  assert.equal(slow.freshness(1511).status, "Stalled");
});

test("one fresh stream cannot mask a late or unmeasurable stream", () => {
  const s = session();
  s.request({ ...s.active.get(1)!.request, id: 2, ...timing(10) });
  s.receive({ tag: 5, id: 2 });
  packet(s, 1000, 1010);
  assert.equal(s.freshness(1010).status, "Unknown");
  packet(s, 1000, 1010, 2);
  packet(s, 1010, 1100);
  packet(s, 1100, 1110, 2);
  assert.equal(s.freshness(1110).status, "Late");
  assert.equal(s.freshness(1110).worst!.id, 1);
  assert.equal(s.freshness(1110).streams.find(x => x.id === 2)!.status, "Fresh");
  s.request({ ...s.active.get(1)!.request, sequenceNumberFormat: 2, bundles: [[], ...s.active.get(1)!.request.bundles] });
  s.receive({ tag: 5, id: 1 });
  assert.equal(s.freshness(1110).status, "Fresh", "On-change snapshots do not age the indicator");
  s.stop(2);
  assert.equal(s.freshness(1110).status, "Inactive");
});

test("missing/expired clocks, replacement and retirement never retain a healthy result", () => {
  const s = session();
  setClock(s, undefined); packet(s, 1000, 1010);
  assert.equal(s.freshness(1010).status, "Unknown");
  setClock(s, { offset: 9_007_199_254_740_993n, delay: 20_000_000n, at: 1000 });
  packet(s, 1010, 1020);
  assert.equal(s.freshness(1020).status, "Fresh");
  assert.equal(s.freshness(31_001).status, "Stalled");
  const request = s.active.get(1)!.request;
  s.request(request); s.receive({ tag: 8, id: 1, reason: "Replaced" });
  s.receive({ tag: 5, id: 1 });
  assert.equal(s.freshness(1020).status, "Unknown");
  assert.equal(s.freshness(1020).worst!.thresholdMs, undefined);
  s.retire();
  assert.equal(s.freshness(1020).status, "Inactive");
});


test("repeated frozen acquisitions never train a stale stream back to Fresh", () => {
  const s=session();packet(s,1000,1010);
  const sub=s.active.get(1)!, threshold=sub.freshness.thresholdMs;
  for(let now=1040;now<=6040;now+=10) {
    assert.ok(packet(s,1000,now));
    assert.equal(s.freshness(now).status, now > 1510 ? "Stalled" : "Fresh");
    assert.equal(s.freshness(now).worst!.ageMs, now > 1510 ? undefined : 10);
    assert.equal(sub.freshness.thresholdMs,threshold);
  }
  assert.ok(sub.packets>500);assert.equal(sub.acquiredAtArrival,1010);
  packet(s,6050,6060);assert.equal(s.freshness(6060).status,"Fresh");
});

test("a schedule interval change judges the retained acquisition during a source stall", () => {
  const s = session();
  packet(s, 1000, 1010);
  assert.equal(s.freshness(1400).status, "Fresh");
  s.changeSchedule(1, timing(50));
  const stalled = s.freshness(1400).worst!;
  assert.equal(stalled.status, "Fresh");
  assert.equal(stalled.ageMs, 10);
  assert.equal(stalled.thresholdMs, 50); // 10 ms probe latency + two 20 ms intervals
  assert.equal(s.active.get(1)!.acquiredAtArrival, 1010);
  packet(s, 1000, 1410);
  assert.equal(s.freshness(1410).worst?.thresholdMs, 50);
  packet(s, 1410, 1420);
  assert.equal(s.freshness(1420).status, "Fresh");
});
