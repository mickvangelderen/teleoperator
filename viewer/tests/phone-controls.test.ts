import assert from "node:assert/strict";
import { test } from "node:test";
import { phoneControlsOnly } from "../src/phone-controls";

const group = (...ids: string[]) => ids.map(id => ({ id, name: id, description: "", group: 7, kind: 1, formats: [1], spaces: [] }));

test("acknowledge phone control events while keeping sensor and mixed groups continuous", () => {
  const controls = ["/phone/input/integer", "/phone/input/deadman/click", "/phone/input/deadman/click/press_count",
    "/phone/input/deadman/click/release_count", "/phone/input/trigger/value"];
  assert.ok(phoneControlsOnly(group(...controls)));
  assert.ok(!phoneControlsOnly(group(...controls, "/phone/input/grip/pose")));
  assert.ok(!phoneControlsOnly(group("/phone/accelerometer/x", "/phone/accelerometer/x/active")));
  const click = "/user/hand/left/input/select/click";
  assert.ok(phoneControlsOnly(group("/user/hand/left/phone/selected", click, click + "/active", click + "/release_count")));
  assert.ok(!phoneControlsOnly(group(click)), "a standard headset select binding alone does not identify a phone");
});
