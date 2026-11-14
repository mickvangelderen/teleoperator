import { test } from "node:test";
import assert from "node:assert/strict";
import { TwoSecondMedian, Latest } from "../src/statistics";

test("a slow consumer holds exactly the latest value", () => {
  const consumer = new Latest<number>();
  for (let i = 0; i < 100; i++) consumer.put(i);
  assert.equal(consumer.coalesced, 99); assert.equal(consumer.take(), 99);
  assert.equal(consumer.take(), null); assert.equal(consumer.consumed, 1);
});

test("two-second median rejects spikes and expires old measurements", () => {
  const median = new TwoSecondMedian();
  assert.equal(median.update(10, 10), 10);
  assert.equal(median.update(20, 120), 15);
  assert.equal(median.update(1000, 1200), 20);
  assert.equal(median.update(30, 2030), 30);
  assert.equal(median.update(40, 5040), 40);
});

test("missing values and resets clear the median history", () => {
  const median = new TwoSecondMedian();
  assert.equal(median.update(60, 100), 60);
  assert.equal(median.update(undefined, 200), undefined);
  assert.equal(median.update(30, 340), 30);
  median.reset();
  assert.equal(median.update(10, 410), 10);
});

test("arrival rate median smooths short bursts, follows sustained changes and falls to zero", () => {
  const median = new TwoSecondMedian();
  for (let now = 0; now < 2000; now += 10) assert.equal(median.update(60, now), 60);
  for (let now = 2000; now < 2200; now += 10) assert.equal(median.update(600, now), 60);
  for (let now = 2200; now < 4200; now += 10) median.update(30, now);
  assert.equal(median.update(30, 4200), 30);
  for (let now = 4210; now < 6210; now += 10) median.update(0, now);
  assert.equal(median.update(0, 6210), 0);
});

test("median history expires at exactly two seconds", () => {
  const median = new TwoSecondMedian();
  median.update(60, 0);
  assert.equal(median.update(30, 1999), 45);
  assert.equal(median.update(30, 2000), 30);
});
