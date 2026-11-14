import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMeasurement } from "../src/ui/format";

test("measurement formatting distinguishes unavailable, zero and signed values with explicit precision", () => {
  for (const value of [undefined, null, NaN, Infinity]) assert.equal(formatMeasurement(value, "ms"), "—");
  assert.equal(formatMeasurement(0, "Hz", 1), "0.0 Hz");
  assert.equal(formatMeasurement(-3, "ms"), "-3.00 ms");
  assert.equal(formatMeasurement(59.8, "fps", 0), "60 fps");
  assert.equal(formatMeasurement(1.234), "1.23");
});
