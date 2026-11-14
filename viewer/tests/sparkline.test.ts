import assert from "node:assert/strict";
import { test } from "node:test";
import { SparklineHistory } from "../src/sparkline";

test("mini graphs retain brief age peaks, missing data and signed values in a bounded ten-second window", () => {
  const age = new SparklineHistory();
  age.add(100, 400, true); age.add(120, 5, true);
  assert.deepEqual(age.samples, [{ at: 100, value: 400 }]);
  age.add(200, undefined); age.add(300, -5); age.add(400, NaN);
  assert.deepEqual(age.samples.slice(1), [{ at: 200, value: undefined }, { at: 300, value: -5 }, { at: 400, value: undefined }]);
  age.add(10_101, 5);
  assert.equal(age.samples[0].at, 200);
  for (let now = 11_000; now < 30_000; now++) age.add(now, now);
  assert.ok(age.samples.length <= 101);
  assert.equal(age.samples.at(-1)!.value, 29_999, "Non-peak lines use the latest reading in each bucket");
});
