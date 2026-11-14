import assert from "node:assert/strict";

export async function checkMetricMedians(page) {
  const result = await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const { profiler } = await import("/src/performance.ts");
    const requestFrame = window.requestAnimationFrame, sampleAge = Session.prototype.sampleAge;
    const freshness = Session.prototype.freshness, latency = Session.prototype.latestNetworkLatency;
    const tracking = Session.prototype.tracking, frameRate = profiler.frameRate;
    const subscriptions = new Set();
    let estimate = 50, usedOldFrameTime = false, latestArguments;
    window.requestAnimationFrame = callback => requestFrame(time => callback(time - 250));
    Session.prototype.sampleAge = function (_timestamp, now, renderToPhoton) {
      if (renderToPhoton === undefined) return sampleAge.call(this, _timestamp, now);
      if (performance.now() - now > 100) usedOldFrameTime = true;
      latestArguments = { renderToPhoton };
      return estimate;
    };
    Session.prototype.latestNetworkLatency = () => estimate;
    profiler.frameRate = () => Math.max(0, estimate ?? 0);
    Session.prototype.freshness = function (now) {
      const result = freshness.call(this, now);
      for (const stream of result.streams) {
        stream.ageMs = estimate;
        stream.thresholdMs = estimate === undefined ? undefined : estimate + 20;
      }
      return result;
    };
    Session.prototype.tracking = function (...args) {
      const packet = tracking.apply(this, args);
      if (packet) {
        const sub = this.active.get(packet.id);
        if (sub.request.schedule.kind !== "onChange") { sub.arrivals = Array(Math.max(0, estimate ?? 0)).fill(args[1]); subscriptions.add(sub); }
      }
      return packet;
    };
    const read = () => Object.fromEntries(["sample-age", "freshness-age", "estimated-latency", "arrival-rate", "frame-rate", "freshness-threshold"].map(id => [id, document.getElementById(id).textContent]));
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      await wait(2100);
      const baseline = read();
      estimate = 1000; await wait(200);
      const spike = read();
      const graphSpikes = ["#age-chart path", ".freshness-age-line", ".freshness-threshold-line", "#latency-chart path", ".arrival-actual-line", "#frame-chart path"].map(selector => {
        const path = document.querySelector(selector).getAttribute("d");
        const y = [...path.matchAll(/[ML]-?[\d.]+,(-?[\d.]+)/g)].map(match => Number(match[1]));
        return { selector, changed: Math.abs(y.at(-1) - y.at(-4)) > 1 };
      });
      estimate = 75; await wait(2100);
      const sustained = read();
      estimate = undefined; await wait(100);
      const missing = read();
      estimate = -3; await wait(100);
      const ahead = read()["sample-age"], defaults = latestArguments;
      const input = document.querySelector("#render-to-photon");
      input.value = "30"; input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(100);
      const changed = latestArguments;
      input.value = "-1"; input.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(100);
      const invalid = latestArguments;
      return { baseline, spike, graphSpikes, sustained, missing, ahead, defaults, changed, invalid, usedOldFrameTime };
    } finally {
      window.requestAnimationFrame = requestFrame; Session.prototype.sampleAge = sampleAge;
      Session.prototype.freshness = freshness; Session.prototype.latestNetworkLatency = latency;
      Session.prototype.tracking = tracking; profiler.frameRate = frameRate;
      for (const sub of subscriptions) sub.arrivals.length = 0;
      const input = document.querySelector("#render-to-photon");
      input.value = "20"; input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  const expected = value => ({ "sample-age": `${value}.00 ms`, "freshness-age": `${value}.0 ms`, "estimated-latency": `${value}.00 ms`, "arrival-rate": `${value}.0 Hz`, "frame-rate": `${value} fps`, "freshness-threshold": `Late above ${value + 20}.0 ms` });
  assert.deepEqual(result.baseline, expected(50));
  assert.deepEqual(result.spike, expected(50), "Every displayed metric rejects a brief spike");
  for (const graph of result.graphSpikes) assert.equal(graph.changed, true, `${graph.selector} must still show the raw spike`);
  assert.deepEqual(result.sustained, expected(75), "All displayed values follow sustained changes within two seconds");
  for (const id of ["sample-age", "freshness-age", "estimated-latency", "freshness-threshold"]) assert.equal(result.missing[id], id === "freshness-threshold" ? "Late above —" : "—", "Missing estimates clear display history immediately");
  assert.equal(result.ahead, "-3.00 ms");
  assert.deepEqual(result.defaults, { renderToPhoton: 20 });
  assert.deepEqual(result.changed, { renderToPhoton: 30 });
  assert.deepEqual(result.invalid, result.changed, "Invalid display delays do not affect the calculation");
  assert.equal(result.usedOldFrameTime, false, "Sample age uses current time rather than the earlier frame timestamp");
}

export async function checkFrameRefresh(page) {
  const result = await page.evaluate(async () => {
    const { profiler } = await import("/src/performance.ts");
    const table = document.querySelector("#subscriptions");
    const nodes = [...table.querySelectorAll("*")];
    let frames = 0, updates = 0, charts = 0, replacements = 0, unchangedAvailability = 0;
    const end = profiler.end, transfer = profiler.sampleTransfer;
    profiler.end = function (metric, start) {
      if (metric === "ui") updates++;
      return end.call(this, metric, start);
    };
    profiler.sampleTransfer = function (...args) { charts++; return transfer.apply(this, args); };
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "childList") replacements += [...record.addedNodes, ...record.removedNodes].filter(n => n.nodeType === Node.ELEMENT_NODE).length;
        else if (record.oldValue === record.target.getAttribute("data-available")) unchangedAvailability++;
      }
    });
    observer.observe(table, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-available"], attributeOldValue: true });
    try {
      await new Promise(resolve => {
        const tick = () => { if (++frames === 60) resolve(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      const current = table.querySelectorAll("*");
      return { frames, updates, charts, replacements, unchangedAvailability, retained: current.length === nodes.length && nodes.every((node, i) => current[i] === node) };
    } finally {
      profiler.end = end; profiler.sampleTransfer = transfer; observer.disconnect();
    }
  });
  assert.ok(Math.abs(result.updates - result.frames) <= 1, `UI must update with animation frames: ${JSON.stringify(result)}`);
  assert.ok(Math.abs(result.charts - result.frames) <= 1, "Performance panel must update with animation frames");
  assert.equal(result.retained, true);
  assert.equal(result.replacements, 0);
  assert.equal(result.unchangedAvailability, 0);
  return result;
}
