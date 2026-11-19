import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultBundles, isGamepadGroup } from "../src/default-bundles";
import type { Capabilities, Descriptor } from "../src/protocol";

const sample = (id: string, group = 0): Descriptor => ({ id, group, kind: 1, name: id, description: "", formats: [1], spaces: [] });

test("unknown-layout gamepad inputs go on change without moving unrelated samples or groups", () => {
  const c: Capabilities = { groups: [100, 90], skeletons: [], descriptors: [
    sample("/gamepad/connected"), sample("/gamepad/raw/axis/0"), sample("/gamepad/raw/axis/0/active"),
    sample("/other"), sample("/user/gamepad/input/a/click", 1),
  ] };
  assert.equal(isGamepadGroup(c, 0), true);
  assert.equal(isGamepadGroup(c, 1), false);
  const indices = (group: number, rest = false) => defaultBundles(c, group, rest).map(b => b.map(s => s.descriptor));
  assert.deepEqual(indices(0), [[3], [0], [1, 2]]);
  assert.deepEqual(indices(1), [[4]]);
  assert.deepEqual(indices(1, true), [[], [4]]);
});

test("mapped analogs keep their own activity while stick clicks and extension buttons stay digital", () => {
  const mapped = "/user/gamepad/input/";
  const digital = ["/gamepad/connected", "/gamepad/activity", mapped + "thumbstick_left/click",
    mapped + "thumbstick_left/click/active", mapped + "thumbstick_left/click/press_count",
    mapped + "thumbstick_left/click/release_count", "/gamepad/input/paddle1/click"];
  const analog = ["trigger_left/value", "trigger_right/value", "thumbstick_left/y", "thumbstick_right"]
    .map(control => [mapped + control, mapped + control + "/active"]);
  const descriptors = [...analog[3], ...digital, ...analog[2], ...analog[0], ...analog[1]].map(id => sample(id));
  const c: Capabilities = { groups: [100], skeletons: [], descriptors };
  const ids = defaultBundles(c, 0, false).map(bundle => bundle.map(s => descriptors[s.descriptor].id));
  assert.deepEqual(ids, [[], digital, ...analog]);
});

test("sparse raw axes get independent bundles in numeric order, including beyond eight on-change bundles", () => {
  const digital = ["/gamepad/connected", "/gamepad/raw/hat/0/up", "/gamepad/raw/hat/0/up/release_count",
    "/gamepad/raw/button/1", "/gamepad/raw/button/1/active"];
  const axis = (n: number) => ["/gamepad/raw/axis/" + n, "/gamepad/raw/axis/" + n + "/active"];
  const numbers = [0, 2, 3, 4, 7, 12, 19, 24];
  const descriptors = [...numbers.toReversed().flatMap(axis), ...digital].map(id => sample(id));
  const c: Capabilities = { groups: [100], skeletons: [], descriptors };
  const ids = defaultBundles(c, 0, false).map(bundle => bundle.map(s => descriptors[s.descriptor].id));
  assert.deepEqual(ids, [[], digital, ...numbers.map(axis)]);
});

test("SDL Guide and its companions go on change with or without a continuous virtual pose", () => {
  const guide = "/gamepad/input/guide/click";
  const raw: Descriptor[] = [
    sample("/gamepad/connected"), sample("/gamepad/activity"),
    { ...sample(guide), kind: 2, press_count_sample: 4, release_count_sample: 5 },
    sample(guide + "/active"),
    { ...sample(guide + "/press_count"), kind: 3, formats: [2, 3, 4, 5] },
    { ...sample(guide + "/release_count"), kind: 4, formats: [2, 3, 4, 5] },
  ];
  const pose = "/gamepad/virtual/pose";
  const continuous: Descriptor[] = [
    { ...sample(pose), kind: 10, formats: [10], spaces: [6], position_valid_sample: 7 },
    { ...sample(pose + "/position_valid"), kind: 12 }, sample("/gamepad/virtual/enabled"),
  ];
  for (const extra of [[], continuous]) {
    const c: Capabilities = { groups: [100], skeletons: [], descriptors: [...raw, ...extra] };
    const bundles = defaultBundles(c, 0, false).map(b => b.map(s => c.descriptors[s.descriptor].id));
    assert.deepEqual(bundles, [extra.map(d => d.id), raw.map(d => d.id)]);
  }
});
