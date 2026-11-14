import { periodic, NON_MAX } from "../src/protocol";
import assert from "node:assert/strict";
import { test } from "node:test";
import { FreshnessBaseline } from "../src/freshness";
import { Session } from "../src/session";

function session(rate = 100, delivery = 1) {
  const s = new Session();
  s.receive({ tag: 2, version: 1 });
  s.receive({ tag: 3, capabilities: { groups: [200], skeletons: [], descriptors: [
    { id: "button", name: "Button", description: "", kind: 2, formats: [1], spaces: [], group: 0 },
  ] } });
  s.request({ id: 1, group: 0, delivery, schedule:periodic(rate), samples: [{ descriptor: 0, format: 1, space: 0 }] });
  s.receive({ tag: 5, id: 1 });
  s.clock = { offset: 9_007_199_254_740_993n, delay: 20_000_000n, at: 1000 };
  return s;
}
function packet(s: Session, acquired: number, arrived: number, id = 1) {
  const bytes = Buffer.alloc(22);
  bytes.writeUInt32LE(id); bytes.writeBigUInt64LE(NON_MAX, 12);
  bytes.writeBigUInt64LE(9_007_199_254_740_993n + BigInt(Math.round(acquired * 1e6)), 4);
  bytes[20] = bytes[21] = 1;
  return s.tracking(bytes, arrived, s.active.get(id)!.request.delivery);
}

test("freshness ages through silence without depending on packet cadence or a display median", () => {
  const s = session();
  assert.equal(s.freshness(1000).status, "Unknown");
  assert.ok(packet(s, 1000, 1010));
  assert.equal(s.freshness(1010).status, "Fresh");
  assert.equal(s.freshness(1030).status, "Fresh");
  assert.equal(s.freshness(1030.001).status, "Late");
  assert.equal(s.freshness(1410).worst!.ageMs, 410);
  assert.equal(s.freshness(1410).worst!.thresholdMs, 30);
  assert.ok(packet(s, 1400, 1410));
  assert.equal(s.freshness(1410).status, "Fresh");
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
    assert.equal(s.freshness(5000).status, "Late");
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
  assert.equal(slow.freshness(1211).status, "Late");
});

test("one fresh stream cannot mask a late or unmeasurable stream", () => {
  const s = session();
  s.request({ ...s.active.get(1)!.request, id: 2, schedule:periodic(10) });
  s.receive({ tag: 5, id: 2 });
  packet(s, 1000, 1010);
  assert.equal(s.freshness(1010).status, "Unknown");
  packet(s, 1000, 1010, 2);
  packet(s, 1100, 1110, 2);
  assert.equal(s.freshness(1110).status, "Late");
  assert.equal(s.freshness(1110).worst!.id, 1);
  assert.equal(s.freshness(1110).streams.find(x => x.id === 2)!.status, "Fresh");
  s.changeSchedule(1, { kind: "onChange" });
  assert.equal(s.freshness(1110).status, "Fresh", "On-change snapshots do not age the indicator");
  s.stop(2);
  assert.equal(s.freshness(1110).status, "Inactive");
});

test("missing/expired clocks, replacement and retirement never retain a healthy result", () => {
  const s = session();
  s.clock = undefined; packet(s, 1000, 1010);
  assert.equal(s.freshness(1010).status, "Unknown");
  s.clock = { offset: 9_007_199_254_740_993n, delay: 20_000_000n, at: 1000 };
  packet(s, 1010, 1020);
  assert.equal(s.freshness(1020).status, "Fresh");
  assert.equal(s.freshness(31_001).status, "Unknown");
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
    assert.equal(s.freshness(now).status,"Late");
    assert.equal(sub.freshness.thresholdMs,threshold);
  }
  assert.ok(sub.packets>500);assert.equal(sub.acquiredAtArrival,1010);
  packet(s,6050,6060);assert.equal(s.freshness(6060).status,"Fresh");
});
