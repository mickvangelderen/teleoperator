import assert from "node:assert/strict";
import { test } from "node:test";
import { mappedControls } from "../src/controller-view";
import type { Capabilities } from "../src/protocol";

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
