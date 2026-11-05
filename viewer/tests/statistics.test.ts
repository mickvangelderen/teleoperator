import { test } from "node:test";
import assert from "node:assert/strict";
import { Sequence, Latest } from "../src/statistics";

test("loss accounting recovers reordered packets and ignores duplicates", () => {
  const s = new Sequence();
  for (const n of [1n, 4n, 2n, 4n]) s.accept(n);
  assert.equal(s.missing, 1n); assert.equal(s.reordered, 1n); assert.equal(s.duplicates, 1n);
  s.accept(3n); assert.equal(s.missing, 0n);
  assert.throws(() => s.accept(0n));
});
test("late traffic is bounded and shared sample sequences start at their reception baseline", () => {
  const s = new Sequence(false, 4n);
  s.accept(100n); s.accept(105n); s.accept(102n); s.accept(100n);
  assert.equal(s.missing, 3n); assert.equal(s.tooLate, 1n); assert.equal(s.unique, 3n);
});
test("a slow consumer holds exactly the latest value", () => {
  const consumer = new Latest<number>();
  for (let i = 0; i < 100; i++) consumer.put(i);
  assert.equal(consumer.coalesced, 99); assert.equal(consumer.take(), 99);
  assert.equal(consumer.take(), null); assert.equal(consumer.consumed, 1);
});
