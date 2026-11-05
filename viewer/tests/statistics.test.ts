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

test("modulo slots preserve accounting across wraps, jumps and 64-bit sequences", () => {
  const s = new Sequence(false, 8n), seen = new Set<bigint>();
  let first = 0n, highest = 0n, unique = 0n, duplicates = 0n, reordered = 0n, tooLate = 0n;
  const large = 2n ** 63n;
  for (const n of [1n, 10n, 7n, 9n, 7n, 3n, 18n, 14n, 17n, 18n, large, large - 3n, large + 2n, large, large - 7n]) {
    if (!first) first = n;
    let accepted = false;
    if (n < first || n <= highest - 8n) tooLate++;
    else if (seen.has(n)) duplicates++;
    else {
      accepted = true;
      if (n < highest) reordered++;
      highest = n > highest ? n : highest;
      unique++; seen.add(n);
    }
    assert.equal(s.accept(n), accepted);
    assert.deepEqual([s.highest, s.unique, s.duplicates, s.reordered, s.tooLate, s.missing],
      [highest, unique, duplicates, reordered, tooLate, highest - first + 1n - unique]);
  }
  assert.throws(() => new Sequence(true, 0n));
  assert.throws(() => new Sequence(true, 65_537n));
});
