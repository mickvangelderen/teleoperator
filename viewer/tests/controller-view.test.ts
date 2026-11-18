import assert from "node:assert/strict";
import { test } from "node:test";
import { CounterEdge, mappedControls } from "../src/controller-view";
import type { Capabilities, Packet } from "../src/protocol";
import { timing } from "../src/protocol";
import type { Subscription } from "../src/session";

test("mapped graphics require known paths and matching protocol kinds", () => {
  const descriptors = [
    ["/gamepad/raw/axis/0", 1], ["/gamepad/raw/button/1", 2],
    ["/user/gamepad/input/trigger_right/value", 1], ["/user/gamepad/input/trigger_left/value", 8],
    ["/user/gamepad/input/thumbstick_right/x", 1], ["/user/gamepad/input/thumbstick_left", 9],
    ["/user/gamepad/input/a/click", 2], ["/extension/input/a/click", 2],
  ] as const;
  const c: Capabilities = { skeletons: [], groups: [100], descriptors: descriptors.map(([id, kind]) =>
    ({ id, kind, group: 0, formats: [kind === 2 ? 1 : 10], spaces: [], name: "South (A)", description: "" })) };
  assert.deepEqual([...mappedControls(c).keys()], ["trigger_left/value", "thumbstick_right/x", "thumbstick_left", "a/click"]);
});

test("button edges use cumulative counts, ignoring repeated frames, stale samples and replacement baselines", () => {
  const request = { id: 1, ...timing(60), group: 0, delivery: 1, sequenceNumberFormat: null, bundles: [[{ descriptor: 0, format: 2, space: 0 }]] };
  const sub: Subscription = { request } as Subscription;
  const edge = new CounterEdge();
  const sample = (value: number, t: number, subscription = sub, stale = false) => ({
    subscription, selection: 0, value, packet: { timestamp: BigInt(t) } as Packet, stale,
  });
  assert.equal(edge.changed(sample(255, 10)), false);
  assert.equal(edge.changed(sample(0, 11)), true);
  assert.equal(edge.changed(sample(0, 11)), false);
  assert.equal(edge.changed(sample(254, 9)), false);
  assert.equal(edge.changed(sample(0, 12)), false);
  assert.equal(edge.changed(sample(3, 16)), true);
  assert.equal(edge.changed(sample(3, 18, sub, true)), false);
  assert.equal(edge.changed(sample(8, 21)), false);
  assert.equal(edge.changed(sample(0, 23, { ...sub })), false);
  assert.equal(edge.changed(undefined), false);
});
