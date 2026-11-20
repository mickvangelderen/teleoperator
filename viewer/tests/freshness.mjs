import assert from "node:assert/strict";

export async function checkFreshness(page, output) {
  await page.waitForFunction(() => document.querySelector("#freshness").dataset.status === "Fresh");
  await page.waitForFunction(() => document.querySelector(".freshness-age-line").getAttribute("d").includes("L"));
  const threshold = await page.locator("#freshness-threshold").textContent();
  assert.match(threshold, /^Late above \d+\.\d ms$/);
  assert.equal(await page.locator("#freshness-chart > :not(path)").count(), 0, "The inline graph has no axes or labels");
  assert.equal(await page.locator(".metric").count(), 5);
  assert.equal(await page.locator(".metric-chart").count(), 5);
  assert.equal(await page.locator(".metrics #status").count(), 0);
  assert.equal(await page.locator(".arrival-requested-line").count(), 3, "On-change groups have no requested cadence line");
  assert.equal(await page.locator(".metric").last().getAttribute("id"), "frame-metric");
  assert.doesNotMatch(await page.locator(".metrics").innerText(), /median|rolling|one-way|Late above|Requested|\bFresh\b/);
  assert.equal(await page.locator("#freshness-status, #freshness .status-dot, #requested-rate").count(), 0);
  assert.equal(await page.locator("#freshness-threshold").isVisible(), false);
  await page.locator("#freshness-chart").hover();
  assert.equal(await page.locator("#freshness-threshold").isVisible(), true);
  assert.match(await page.locator("#freshness-chart-tooltip").textContent(), /2 s medians/);
  assert.ok(await page.locator("#freshness-chart-tooltip .group-median").count() > 0);
  await page.locator("#arrival-chart").hover();
  assert.equal(await page.locator("#arrival-chart-tooltip").isVisible(), true);
  assert.match(await page.locator("#arrival-chart-tooltip").textContent(), /Solid.*Dashed/);
  assert.equal(await page.locator("#arrival-chart-tooltip .group-label").count(), 4);
  await page.mouse.move(0, 0);
  assert.equal(await page.locator("#arrival-chart-tooltip").isVisible(), false);
  const colors = await page.evaluate(() => ({
    controls: [...document.querySelectorAll(".subscription-list [data-action=select]")].map(e => e.style.getPropertyValue("--group-color")),
    arrival: [...document.querySelectorAll(".arrival-actual-line")].map(e => e.getAttribute("stroke")),
    freshness: [...document.querySelectorAll(".freshness-age-line")].map(e => e.getAttribute("stroke")),
  }));
  assert.deepEqual(colors.arrival, colors.controls);
  assert.deepEqual(colors.freshness, colors.controls.slice(0, 3));
  assert.notEqual(colors.controls[0], colors.controls[1]);
  for (const card of await page.locator(".metric").all()) {
    const graph = await card.locator("svg").boundingBox(), value = await card.locator(".metric-value").boundingBox();
    assert.ok(graph.y >= value.y + value.height && graph.width > 150, "Graphs have their own full-width row");
  }
  await page.locator(".metrics").screenshot({ path: output + "freshness-healthy.png" });
  await page.evaluate(async () => {
    const sessionUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/session.ts")?.name ?? "/src/session.ts";
    const { Session } = await import(sessionUrl);
    const original = Session.prototype.tracking, freshness = Session.prototype.freshness, changeSchedule = Session.prototype.changeSchedule;
    window.restoreFreshnessTraffic = () => { Session.prototype.tracking = original; Session.prototype.freshness = freshness; Session.prototype.changeSchedule = changeSchedule; delete window.testFreshness; };
    // Isolate delivery silence from cadence changes, which deliberately reset the baseline.
    Session.prototype.changeSchedule = function (id, schedule) {
      const current = this.active.get(id)?.request;
      return changeSchedule.call(this, id, current ? { ...schedule, interval: current.interval } : schedule);
    };
    Session.prototype.freshness = function (...args) { return window.testFreshness = freshness.apply(this, args); };
    // Deliver valid samples with a measured transport delay, then exercise
    // actual silence separately once the renderer has shown the late samples.
    Session.prototype.tracking = function (bytes, ...args) {
      const delayed = Uint8Array.from(bytes);
      const view = new DataView(delayed.buffer);
      view.setBigUint64(4, view.getBigUint64(4, true) - 180_000_000n, true);
      return original.call(this, delayed, ...args);
    };
    window.pauseFreshnessTraffic = () => { Session.prototype.tracking = () => null; };
  });
  try {
    await page.waitForFunction(() => document.querySelector("#freshness").dataset.status === "Late");
    await page.waitForFunction(() => window.trackingScene.latest[2] === true);
    const scene = await page.evaluate(async () => {
      const Color = window.trackingScene.bodyPoints.material.color.constructor;
      const view = window.trackingScene;
      const points = Array.from({ length: view.bodyPoints.geometry.drawRange.count }, (_, i) => new Color().fromBufferAttribute(view.bodyPoints.geometry.getAttribute("color"), i).getHexString());
      const models = [];
      for (const { group } of view.poses.values()) if (group.visible) group.traverse(object => {
        for (const m of [].concat(object.material ?? [])) if (m.color) models.push(m.color.getHexString());
      });
      return { points, models };
    });
    assert.ok(scene.points.length > 0 && scene.points.every(color => color === "c44235"), "Late freshness makes the live skeleton red");
    assert.ok(scene.models.length > 0 && scene.models.every(color => color === "c44235"), "Late freshness also makes headset and controllers red");
    await page.locator("#poses").screenshot({ path: output + "tracking-late.png" });
    const frozen = await page.evaluate(() => window.testFreshness.streams.map(s => ({ id: s.id, threshold: s.thresholdMs })));
    await page.evaluate(() => { window.pauseFreshnessTraffic(); delete window.pauseFreshnessTraffic; });
    await page.waitForFunction(() => document.querySelector("#freshness").dataset.status === "Stalled" && document.querySelector("#freshness-age").textContent === "—");
    assert.equal(await page.locator("#status").textContent(), "Connected");
    assert.deepEqual(await page.evaluate(() => window.testFreshness.streams.map(s => ({ id: s.id, threshold: s.thresholdMs }))), frozen, "Silence must not relax the underlying freshness threshold");
    assert.notEqual(await page.locator(".freshness-age-line").first().getAttribute("d"), await page.locator(".freshness-threshold-line").first().getAttribute("d"));
    assert.deepEqual(await page.locator(".freshness-age-line").evaluateAll(lines => lines.map(e => e.getAttribute("stroke"))), colors.freshness, "Lateness does not change group identity");
    await page.waitForFunction(() => parseFloat(document.querySelector("#arrival-rate").textContent) === 0);
    assert.ok(parseFloat(await page.locator("#frame-rate").textContent()) > 0, "Rendering continues during a delivery pause");
    assert.match(await page.locator("#estimated-latency").textContent(), /ms$/, "Clock probes continue independently of publication delivery");
    await page.locator(".metrics").screenshot({ path: output + "freshness-late.png" });
    await page.locator("#continuous-render").uncheck();
    await page.waitForFunction(() => document.querySelector("#frame-rate").textContent === "0 fps");
    await page.locator("#skeleton-view").selectOption("rest");
    await page.waitForFunction(() => window.trackingScene.latest[2] === false && window.trackingScene.bodyPoints.geometry.drawRange.count === 70);
    const rest = await page.evaluate(async () => {
      const Color = window.trackingScene.bodyPoints.material.color.constructor;
      return new Color().fromBufferAttribute(window.trackingScene.bodyPoints.geometry.getAttribute("color"), 0).getHexString();
    });
    assert.equal(rest, "78847d", "Rest poses stay neutral during live delivery pauses");
  } finally {
    await page.locator("#skeleton-view").selectOption("live");
    await page.locator("#continuous-render").check();
    await page.evaluate(() => { window.restoreFreshnessTraffic(); delete window.restoreFreshnessTraffic; });
  }
  await page.waitForFunction(() => document.querySelector("#freshness").dataset.status === "Fresh");
}
