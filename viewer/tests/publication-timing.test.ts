import assert from "node:assert/strict";
import { test } from "node:test";
import { periodic } from "../src/protocol";
import { PublicationTiming, scheduleNeedsUpdate } from "../src/publication-timing";
import type { ClockEstimate, PeriodicSchedule } from "../src/publication-timing";

const ns = (ms: number) => BigInt(Math.round(ms * 1e6));
const mod = (a: bigint, b: bigint) => (a % b + b) % b;
const schedule = (rate = 60) => periodic(rate) as PeriodicSchedule;
function frames(timing: PublicationTiming, start: number, cadence = 1000 / 60, count = 13) {
  let frame = start;
  for (let i = 0; i < count; i++) { frame = start + i * cadence; timing.frame(frame, frame + 1); }
  return frame + 1;
}

test("phase aligns publication plus consumption delay with display time across offsets, latency and rates", () => {
  for (const offset of [9_007_199_254_740_993n, -900_000_000n]) for (const transit of [0.5, 12, 80]) for (const rate of [30, 60, 90]) {
    const timing = new PublicationTiming(), cadence = 1000 / 90;
    const now = frames(timing, 1000, cadence);
    timing.received(2, now);
    const clock = { offset, delay: ns(2 * transit), at: now };
    const next = timing.schedule(schedule(rate), now, 20, clock, transit)!;
    assert.equal(next.interval, schedule(90).interval, "Automatic publication follows the observed display cadence");
    assert.ok(next.phase >= 0 && next.phase < next.interval);
    const lead = transit + 2 + 2;
    const renderAt = now + Math.ceil((2 * transit + 2 + 2 + 2) / cadence) * cadence;
    assert.equal(next.phase, mod(ns(renderAt - lead) + offset, next.interval));
    assert.ok(Math.abs(Number(next.consumptionDelay) / 1e6 - (lead + 20)) < 1e-5);
    const publication = ns(renderAt - lead) + offset;
    assert.ok(Math.abs(Number(publication + next.consumptionDelay - offset) / 1e6 - (renderAt + 20)) < 1e-5);
    assert.ok(Number(publication - offset) / 1e6 + transit + 2 <= renderAt - 1.999, "Arrival leaves decoding and margin before render");
  }
});

test("display delay changes prediction target without moving the publication away from its frame", () => {
  const timing = new PublicationTiming(), now = frames(timing, 1000);
  const clock = { offset: 123_456_789n, delay: ns(20), at: now };
  const before = timing.schedule(schedule(), now, 20, clock)!;
  for (const photon of [0, 60, 1000]) {
    const after = timing.schedule(before, now, photon, clock)!;
    assert.equal(after.phase, before.phase);
    assert.equal(after.consumptionDelay - before.consumptionDelay, ns(photon - 20));
    assert.equal(scheduleNeedsUpdate(before, after), true);
  }
});

test("timing waits for fresh clock and frame evidence after missing data, visibility or stalls", () => {
  const timing = new PublicationTiming();
  let now = frames(timing, 1000);
  let clock: ClockEstimate = { offset: 0n, delay: ns(10), at: now };
  assert.ok(timing.schedule(schedule(), now, 20, clock));
  assert.equal(timing.schedule(schedule(), now, 20), undefined);
  assert.equal(timing.schedule(schedule(), now, 20, { ...clock, at: now - 3001 }), undefined);
  timing.reset(now + 10);
  now = frames(timing, now + 20);
  assert.equal(timing.schedule(schedule(), now, 20, clock), undefined, "Pre-resume probes do not authorize timing changes");
  clock = { ...clock, at: now };
  assert.ok(timing.schedule(schedule(), now, 20, clock));
  now += 400;
  timing.frame(now, now);
  assert.equal(timing.schedule(schedule(), now, 20, clock), undefined);
  now = frames(timing, now + 16);
  assert.equal(timing.schedule(schedule(), now, 20, clock), undefined);
  assert.ok(timing.schedule(schedule(), now, 20, { ...clock, at: now }));
  assert.equal(timing.schedule(schedule(), now, -1, { ...clock, at: now }), undefined);
  assert.equal(timing.schedule(schedule(), now, 20, { ...clock, at: now }, 1001), undefined);
});

test("cadence changes and clock drift move the phase while noise stays within the circular deadband", () => {
  const timing = new PublicationTiming(), now = frames(timing, 1000);
  const clock = { offset: 0n, delay: ns(10), at: now };
  const first = timing.schedule(schedule(), now, 20, clock)!;
  const drifted = timing.schedule(first, now, 20, { ...clock, offset: ns(3) })!;
  assert.equal(mod(drifted.phase - first.phase, first.interval), ns(3));
  assert.equal(scheduleNeedsUpdate(first, drifted), true);
  const nextNow = frames(timing, now + 1000 / 80, 1000 / 80);
  const changed = timing.schedule(first, nextNow, 20, { ...clock, at: nextNow })!;
  assert.equal(changed.interval, 12_500_000n);
  assert.equal(scheduleNeedsUpdate(first, changed), true);
  const wrapped = { ...first, phase: first.interval - 200_000n };
  assert.equal(scheduleNeedsUpdate(wrapped, { ...wrapped, phase: 200_000n }), false);
  assert.equal(scheduleNeedsUpdate(first, { ...first, consumptionDelay: first.consumptionDelay + 400_000n }), false);
  assert.equal(scheduleNeedsUpdate(first, { ...first, consumptionDelay: first.consumptionDelay - 600_000n }), true);
});

test("automatic rate follows 100 Hz rendering, respects device limits, and ignores isolated missed frames", () => {
  const timing = new PublicationTiming(), now = frames(timing, 1000, 10);
  const clock = { offset: 0n, delay: ns(6), at: now };
  const matched = timing.schedule(schedule(60), now, 20, clock, undefined, 200)!;
  assert.equal(matched.interval, 10_000_000n);
  assert.equal(scheduleNeedsUpdate(schedule(60), matched), true);
  const limited = timing.schedule(matched, now, 20, clock, undefined, 90)!;
  assert.equal(limited.interval, 11_111_112n, "Never exceed the group's advertised maximum rate");
  timing.frame(now + 29, now + 30);
  assert.equal(timing.schedule(matched, now + 30, 20, clock, undefined, 200)!.interval, matched.interval);
  const stalled = new PublicationTiming();
  for (const at of [1000, 1010, 1020, 1120, 1220]) stalled.frame(at, at + 1);
  assert.equal(stalled.schedule(matched, 1221, 20, { ...clock, at: 1221 }), undefined,
    "Mixed short frames and long stalls must not produce a guessed rate or interrupt rendering");
});

test("ordinary decode cost is covered without predicting extra frames after one processing stall", () => {
  const timing = new PublicationTiming(), now = frames(timing, 1000);
  const clock = { offset: 0n, delay: ns(10), at: now };
  for (let i = 0; i < 20; i++) timing.received(2, now);
  const before = timing.schedule(schedule(), now, 20, clock)!;
  timing.received(100, now);
  const after = timing.schedule(schedule(), now, 20, clock)!;
  assert.deepEqual(after, before, "One isolated stall must not determine the next two seconds of predictions");
  for (let i = 0; i < 20; i++) timing.received(4, now);
  assert.equal(timing.schedule(schedule(), now, 20, clock)!.consumptionDelay - before.consumptionDelay, ns(2));
});
