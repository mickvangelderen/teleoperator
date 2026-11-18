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
