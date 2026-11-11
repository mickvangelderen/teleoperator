import { test } from "node:test";
import assert from "node:assert/strict";
import { Latest } from "../src/statistics";

test("a slow consumer holds exactly the latest value", () => {
  const consumer = new Latest<number>();
  for (let i = 0; i < 100; i++) consumer.put(i);
  assert.equal(consumer.coalesced, 99); assert.equal(consumer.take(), 99);
  assert.equal(consumer.take(), null); assert.equal(consumer.consumed, 1);
});
