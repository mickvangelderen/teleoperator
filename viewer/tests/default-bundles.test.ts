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
  assert.deepEqual(indices(0), [[3], [0, 1, 2]]);
  assert.deepEqual(indices(1), [[4]]);
  assert.deepEqual(indices(1, true), [[], [4]]);
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
