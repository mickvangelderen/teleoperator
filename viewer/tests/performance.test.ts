import { test } from "node:test";
import assert from "node:assert/strict";
import { GpuTimer, MetricHistory, profiler, summarize } from "../src/performance";

test("timing capture retains a bounded rolling window and its worst hiccup", () => {
  const history = new MetricHistory(4);
  history.add(0, 999);
  history.add(10_000, 2); history.add(10_100, 4);
  history.add(10_200, 150); history.add(10_300, 6);
  history.add(10_400, NaN); history.add(10_400, -1);
  const samples = history.samples(10_400);
  assert.equal(samples.length, 4);
  assert.deepEqual(summarize(samples), { current: 6, median: 5, p95: 150, max: 150 });
  assert.deepEqual(history.samples(20_250), [{ at: 10_300, value: 6 }]);
  history.clear();
  assert.deepEqual(history.samples(20_250), []);
  assert.equal(summarize([]), null);
  assert.equal(summarize([{ value: 1 }, { value: 100 }, { value: 2 }])?.median, 2);
});

function gpuFixture() {
  let available = false, disjoint = false, lost = false, deleted = 0, reads = 0;
  const statuses: string[] = [];
  const query = {} as WebGLQuery;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1, QUERY_RESULT: 2,
    getExtension: () => ({ TIME_ELAPSED_EXT: 3, GPU_DISJOINT_EXT: 4 }),
    createQuery: () => query, beginQuery() {}, endQuery() {},
    deleteQuery() { deleted++; }, isContextLost: () => lost,
    getParameter: () => disjoint,
    getQueryParameter: (_query: WebGLQuery, key: number) => {
      if (key === 1) return available;
      reads++; return 2_500_000;
    },
  } as unknown as WebGL2RenderingContext;
  return {
    gl, query, statuses,
    timer: new GpuTimer(gl, status => statuses.push(status)),
    ready() { available = true; }, disjoint() { disjoint = true; }, loseContext() { lost = true; },
    deleted: () => deleted, reads: () => reads,
  };
}

test("GPU timing never reads an unfinished query or queues overlapping queries", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const f = gpuFixture(), results: number[] = [];
  assert.equal(f.timer.begin(0), f.query);
  f.timer.end(f.query, ms => results.push(ms));
  assert.equal(f.reads(), 0);
  context.mock.timers.tick(16);
  assert.equal(f.reads(), 0);
  assert.equal(f.timer.begin(250), null);
  f.ready(); context.mock.timers.tick(16);
  assert.deepEqual(results, [2.5]); assert.equal(f.deleted(), 1);
  assert.equal(f.timer.begin(199), null);
  assert.equal(f.timer.begin(250), f.query);
  f.timer.end(f.query, ms => results.push(ms));
  f.timer.cancel(); context.mock.timers.tick(100);
  assert.deepEqual(results, [2.5]); assert.equal(f.deleted(), 2);
});

test("unreliable, lost-context, timed-out and unsupported GPU samples are not reported", context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  context.mock.method(performance, "now", () => now);
  for (const failure of ["disjoint", "context", "timeout"]) {
    const f = gpuFixture(), results: number[] = [];
    const query = f.timer.begin(0);
    assert.ok(query);
    f.timer.end(query, ms => results.push(ms));
    if (failure === "disjoint") f.disjoint();
    if (failure === "context") f.loseContext();
    if (failure === "timeout") now += 2001;
    context.mock.timers.tick(16);
    assert.deepEqual(results, []);
    assert.equal(f.deleted(), 1); assert.equal(f.reads(), 0);
    assert.match(f.statuses.at(-1)!, /discarded|context lost/);
  }
  const statuses: string[] = [];
  const unsupported = new GpuTimer({ getExtension: () => null } as unknown as WebGL2RenderingContext, status => statuses.push(status));
  assert.equal(unsupported.begin(0), null);
  assert.match(statuses[0], /unavailable/);
});


test("arrival intervals are per stream, measured at reception and reset on a new stream", context => {
  context.mock.method(performance, "now", () => 1000);
  profiler.start();
  profiler.trackingArrival(1, "session:1:1", 100, 100);
  profiler.trackingArrival(2, "session:2:2", 200, 102);
  profiler.trackingArrival(1, "session:1:1", 100, 110);
  profiler.trackingArrival(2, "session:2:2", 200, 127);
  profiler.trackingArrival(1, "session:1:3", 100, 600);
  profiler.trackingArrival(1, "session:1:3", 100, 620);
  const snapshot = profiler.snapshot();
  assert.deepEqual(snapshot.metrics.find(m => m.key === "trackingArrival")!.samples, [{ at: 110, value: 10 }, { at: 127, value: 25 }, { at: 620, value: 20 }]);
  profiler.sampleTransfer(1000);
  assert.equal(profiler.snapshot().transfer.find(m => m.key === "tracking")!.summary!.current, 0.8);
  profiler.stop();
});
