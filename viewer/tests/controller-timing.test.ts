import assert from "node:assert/strict";
import { test } from "node:test";
import { ControllerTiming } from "../src/controller-timing";
import { sequencePosition, type Timing } from "../src/protocol";

const grid: Timing = { interval: 16_000_000n, phase: 0n, predictionOffset: 0n };
const remote = 10_000_000_000n;
function publish(guard: ControllerTiming, slot: number, delay: number, ageAtSlot = -0.06, uncertainty = 0.3, position?: bigint) {
  const now = slot + delay;
  guard.observe(remote + BigInt(Math.round((slot - ageAtSlot) * 1e6)), now, grid,
    { offset: remote, delay: 400_000n, at: now }, remote + BigInt(Math.round(uncertainty * 1e6)), position);
}

test("one late publication cannot move the learned minimum; a sustained step displaces all eight and recovers", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i <= 8; i++) publish(guard, i * 16, 0.5);
  assert.equal(guard.deliveryMs(), 0.5);
  publish(guard, 9 * 16, 7);
  assert.equal(guard.deliveryMs(), 0.5);
  assert.equal(guard.missedBudgetSince(1, 0), false, "A rejected delay cannot bypass admission through scheduling");
  publish(guard, 10 * 16, 0.5);
  for (let i = 11; i < 18; i++) { publish(guard, i * 16, 6); assert.equal(guard.deliveryMs(), 0.5); }
  publish(guard, 18 * 16, 6);
  assert.equal(guard.deliveryMs(), 6);
  assert.equal(guard.missedBudgetSince(1, 0), true);
  publish(guard, 19 * 16, 0.5);
  assert.equal(guard.deliveryMs(), 0.5);
});

test("turnover applies the three-jitter spike gate using the selected sample's age", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i <= 8; i++) publish(guard, i * 16, 0.5);
  for (let i = 9; i <= 16; i++) publish(guard, i * 16, 4 + (i - 9) / 10);
  // Best now 4 ms, selected at slot 9, less than two polls after the previous
  // selection. Waiting until the eighth slot retired cannot admit this sample.
  assert.equal(guard.deliveryMs(), 0.5);
  publish(guard, 17 * 16, 4.8);
  assert.equal(guard.deliveryMs(), 4.1, "The next independent minimum spans two polls and admits the path change");
});

test("unattributable multi-period delays use the probe fallback and retain learned path state", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i <= 8; i++) publish(guard, i * 16, 0.5);
  for (let i = 9; i <= 16; i++) publish(guard, i * 16, 23, 4);
  assert.equal(guard.deliveryMs(), undefined);
  publish(guard, 1000 * 16, 0.5);
  assert.equal(guard.deliveryMs(), 0.5, "Idle time and rejected samples did not erase the 8-stage filter");
});

test("unwrapped progress attributes cached acquisitions across loss and skips reordered packets", () => {
  for (const format of [1, 2, 3] as const) {
    const bits = { 1: 16, 2: 32, 3: 64 }[format];
    const start = (1n << BigInt(bits)) - 3n;
    const guard = new ControllerTiming();
    let newest: bigint | undefined;
    function deliver(i: number, delay: number, ageAtSlot: number) {
      const wire = BigInt.asUintN(bits, start + BigInt(i));
      const position = sequencePosition(wire, newest, format)!;
      if (newest === undefined || position > newest) newest = position;
      publish(guard, 16 * i, delay, ageAtSlot, 0.3, position);
    }
    deliver(0, 0.5, -0.06);
    deliver(1, 0.5, -0.06); // The one independently attributable slot.
    for (const i of [2, 3, 6, 7, 8, 9, 10]) deliver(i, 0.5, 8);
    assert.equal(guard.deliveryMs(), 0.5);
    deliver(9, 22, 8);
    deliver(10, 14, 8);
    assert.equal(guard.deliveryMs(), 0.5);
    for (let i = 11; i < 19; i++) deliver(i, 2.5, 8);
    assert.equal(guard.deliveryMs(), 2.5);
  }
});

test("a new timing epoch drops its slot anchor and filters pre-change acquisitions", () => {
  const guard = new ControllerTiming();
  for (let i = 0; i <= 10; i++) publish(guard, 16 * i, 0.5, -0.06, 0.3, BigInt(i));
  guard.changed(200, remote + 300_000n);
  publish(guard, 16 * 16, 3, 80, 0.3, 16n); // Pre-update cached snapshot.
  publish(guard, 16 * 17, 3, 8, 0.3, 17n); // New epoch still needs its own anchor.
  assert.equal(guard.deliveryMs(), 0.5);
  publish(guard, 16 * 18, 0.7, -0.06, 0.3, 18n);
  for (let i = 19; i < 27; i++) publish(guard, 16 * i, 3, 8, 0.3, BigInt(i));
  assert.equal(guard.deliveryMs(), 3);
});
