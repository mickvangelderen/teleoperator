import assert from "node:assert/strict";
import { test } from "node:test";
import { ControllerTiming } from "../src/controller-timing";
import type { Timing } from "../src/protocol";

const grid: Timing = { interval: 16_000_000n, phase: 0n, predictionOffset: 0n };
const remote = 10_000_000_000n;
function publish(guard: ControllerTiming, slot: number, delay: number, ageAtSlot = -0.06, uncertainty = 0.3) {
  const now = slot + delay;
  guard.observe(remote + BigInt(Math.round((slot - ageAtSlot) * 1e6)), now, grid,
    { offset: remote, delay: 400_000n, at: now }, remote + BigInt(Math.round(uncertainty * 1e6)));
}

test("controller delivery learns slow publications and holds the guard through an idle on-change stream", () => {
  const guard = new ControllerTiming();
  publish(guard, 0, 12); // immediate first publication
  for (let i = 1; i <= 8; i++) publish(guard, i * 16, 0.8);
  assert.equal(guard.deliveryMs(), 0.8);
  publish(guard, 144, 4.5);
  assert.equal(guard.deliveryMs(), 4.5);
  publish(guard, 10_000 * 16, 0.6); // one change after a long idle
  assert.equal(guard.deliveryMs(), 4.5);
  for (let i = 1; i <= 64; i++) publish(guard, (10_000 + i) * 16, 0.6);
  assert.equal(guard.deliveryMs(), 0.6);
});

test("controller timing rejects ambiguous slots, repeated acquisitions and unsettled phases", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i < 20; i++) publish(guard, i * 16, 2.5, 8);
  assert.equal(guard.deliveryMs(), undefined, "Old acquisition could belong to either slot");
  guard.changed(400);
  for (let i = 0; i < 16; i++) publish(guard, 416, 1);
  for (let i = 0; i < 16; i++) publish(guard, (32 + i) * 16, 15.9, -0.06, 2);
  assert.equal(guard.deliveryMs(), undefined, "Clock uncertainty crosses the next slot");
  for (let i = 0; i < 64; i++) publish(guard, (64 + i) * 16, 0.8);
  assert.equal(guard.deliveryMs(), 0.8);
  for (let i = 0; i < 16; i++) publish(guard, 128 * 16, 2.1);
  assert.equal(guard.deliveryMs(), 2.1);
});

test("ambiguous long deliveries cannot tighten the budget built from attributable slots", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i < 10; i++) publish(guard, i * 16, 3.5);
  for (let i = 10; i < 90; i++) publish(guard, i * 16, i % 2 ? 0.5 : 22);
  assert.equal(guard.deliveryMs(), 3.5);
  for (let i = 90; i < 154; i++) publish(guard, i * 16, 0.5);
  assert.equal(guard.deliveryMs(), 0.5);
});

test("recurrent data-path variation earns an additional late-delivery reserve", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i < 65; i++) publish(guard, i * 16, i % 4 === 0 ? 6 : 4);
  assert.equal(guard.deliveryMs(), 8); // peak 6 ms plus the measured 2 ms excursion
  for (let i = 65; i <= 128; i++) publish(guard, i * 16, 4);
  assert.equal(guard.deliveryMs(), 4);
});
