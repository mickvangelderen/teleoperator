import assert from "node:assert/strict";
import { selectedEntry, applySelected } from "./editor-browser.mjs";

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

    const secondBefore = await selectedEntry(second);
    await first.locator('[data-field="automatic"]').uncheck();
    await first.locator('[data-field="rate"]').fill("30");
    await applySelected(first);
    assert.ok(Math.abs((await selectedEntry(first)).rate - 30) < .001);
    const secondAfter = await selectedEntry(second);
    assert.equal(secondAfter.activeId, secondBefore.activeId, "Editing another viewer does not replace this subscription");
    assert.equal(await second.evaluate(() => {
      const editor = document.querySelector("subscription-editor"), entry = editor.model.entries.find(e => e.group === 0);
      return entry.draft.automatic && editor.model.port.isAutomatic(entry.activeId);
    }), true, "The other viewer retains display alignment; its actual cadence can vary under concurrent rendering");
    const packets = (await selectedEntry(second)).packets;
    await first.locator("#connect").click();
    await second.waitForFunction(previous => {
      const e = document.querySelector("subscription-editor");
      const entry = e.model.entries.find(s => s.group === 0);
      return e.model.port.session.active.get(entry.activeId).packets >= previous + 30;
    }, packets);
    assert.equal(await second.locator("#status").textContent(), "Connected");
    await second.locator("#connect").click();
    assert.deepEqual(errors, []);
    console.log("PASS: two viewers retain independent subscriptions, skip off-screen visual work, and resume visible rows/graphs without replacing controls");
  } finally { await context.close(); }
}
