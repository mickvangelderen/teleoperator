import assert from "node:assert/strict";

export async function checkMultipleViewers(browser, url) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  try {
    const first = await context.newPage();
    await first.goto(url);
    // Keep an opener relationship so both viewers can share a renderer thread.
    const popup = first.waitForEvent("popup");
    await first.evaluate(url => window.open(url), url);
    const second = await popup;
    for (const page of [first, second]) {
      page.on("pageerror", error => errors.push(error.message));
      await page.locator("#connect").click();
      await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70");
    }
    const sampleWork = page => page.evaluate(async () => {
      const TimeSeriesGraph = customElements.get("time-series-graph");
      const { profiler } = await import("/src/performance.ts");
      let charts = 0, values = 0, frames = 0;
      const update = TimeSeriesGraph.prototype.update;
      TimeSeriesGraph.prototype.update = function (...args) { charts++; return update.apply(this, args); };
      const observer = new MutationObserver(records => {
        values += records.filter(r => r.target.parentElement?.closest(".sample-value")).length;
      });
      observer.observe(document.querySelector("#subscriptions"), { characterData: true, childList: true, subtree: true });
      const nodes = [...document.querySelectorAll("#subscriptions *")];
      try {
        await new Promise(resolve => {
          const tick = () => ++frames === 30 ? resolve() : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        });
        const current = document.querySelectorAll("#subscriptions *");
        return { charts, values, retained: nodes.length === current.length && nodes.every((node, i) => node === current[i]),
          recorded: profiler.snapshot().transfer.every(metric => metric.samples.length > 0) };
      } finally { observer.disconnect(); TimeSeriesGraph.prototype.update = update; }
    });
    for (const result of await Promise.all([sampleWork(first), sampleWork(second)])) {
      assert.equal(result.charts, 0, "Off-screen performance graphs must not redraw");
      assert.equal(result.values, 0, "Off-screen sample values must not trigger layout");
      assert.equal(result.recorded, true, "Performance history continues while graphs are off-screen");
      assert.equal(result.retained, true, "Frame updates retain controls and rows");
    }
    await first.locator('[data-descriptor="/user/head/input/pose"]').scrollIntoViewIfNeeded();
    await first.waitForFunction(() => document.querySelector('[data-descriptor="/user/head/input/pose"]').dataset.available === "true");
    assert.ok((await sampleWork(first)).values > 0, "Visible rows resume live updates after scrolling");
    await first.locator("#performance").scrollIntoViewIfNeeded();
    assert.ok((await sampleWork(first)).charts > 0, "Visible graphs draw the retained history");

    await first.locator("#automatic-0").uncheck();
    await first.locator("#rate-0").fill("30");
    await first.locator("#publish-0").click();
    await first.waitForFunction(() => document.querySelector("#subscription-0").textContent.includes("30.0 Hz target"));
    const secondRate = Number((await second.locator("#subscription-0").textContent()).match(/([\d.]+) Hz target/)[1]);
    assert.ok(secondRate > 55 && secondRate < 65, "The other viewer keeps its measured display cadence when the first switches to 30 Hz");
    const packets = Number((await second.locator("#subscription-0").textContent()).match(/(\d+) packets/)[1]);
    await first.locator("#connect").click();
    await second.waitForFunction(previous => Number(document.querySelector("#subscription-0").textContent.match(/(\d+) packets/)?.[1]) >= previous + 30, packets);
    assert.equal(await second.locator("#status").textContent(), "Connected");
    await second.locator("#connect").click();
    assert.deepEqual(errors, []);
    console.log("PASS: two viewers retain independent subscriptions, skip off-screen visual work, and resume visible rows/graphs without replacing controls");
  } finally { await context.close(); }
}
