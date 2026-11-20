import { checkVisualizationChoices } from "./visualizations.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const output = fileURLToPath(new URL("../../.artifacts/viewer/components/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/tests/components.html", process.env.VIEWER_URL || "http://127.0.0.1:5173").href);
  await page.waitForFunction(() => !!window.componentsFixture);
  assert.equal(await page.locator("#example-metric .metric-value").textContent(), "-3.00 ms");
  assert.equal(await page.locator("#missing-metric .metric-value").textContent(), "—");

  // Keyboard and pointer access use the same tooltip, including Escape dismissal.
  const trigger = page.locator("#example-metric"), tooltip = page.locator("#example-chart-tooltip");
  assert.equal(await tooltip.isVisible(), false);
  await page.keyboard.press("Tab");
  assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
  assert.equal(await tooltip.isVisible(), true);
  await page.keyboard.press("Escape");
  assert.equal(await tooltip.isVisible(), false);
  await page.keyboard.press("Tab");
  await trigger.hover();
  assert.equal(await tooltip.isVisible(), true);
  await tooltip.hover();
  assert.equal(await tooltip.isVisible(), true, "Tooltip stays available while its text is hovered");
  await page.mouse.move(0, 0);
  assert.equal(await tooltip.isVisible(), false);

  for (const target of [trigger.locator(".metric-label"), trigger.locator(".metric-value"), trigger.locator("svg")]) {
    await target.hover(); assert.equal(await tooltip.isVisible(), true);
    await tooltip.hover(); assert.equal(await tooltip.isVisible(), true);
    await page.mouse.move(0, 0); assert.equal(await tooltip.isVisible(), false);
  }
  const tile = await trigger.boundingBox();
  await page.mouse.move(tile.x + 2, tile.y + tile.height / 2);
  assert.equal(await tooltip.isVisible(), true, "Padding belongs to the hover target too");
  assert.equal(await tooltip.locator('[data-group="0"] .group-label').textContent(), "Body tracking");
  assert.equal(await tooltip.locator('[data-group="1"] .group-label').textContent(), "Group 1");
  assert.equal(await tooltip.locator('[data-group="1"] .group-note').textContent(), "Unavailable");
  await page.evaluate(() => {
    let tick = 0;
    window.selectionNodes = [...document.querySelectorAll("#example-metric .metric-label, #example-metric strong, #example-chart-tooltip .group-label, #example-chart-tooltip .group-median")].map(node => [node, node.firstChild]);
    window.selectionTimer = setInterval(() => {
      tick++; window.componentsFixture.metric.update(-3 - tick / 100);
      window.componentsFixture.legend([{ group: 0, label: "Body tracking", value: -3 - tick / 100 }, { group: 1 }]);
    }, 30);
  });
  try {
    // Real mouse selections must survive refresh: assigning Text.data on the
    // same node would reset selection offsets even with stable element identity.
    for (const selector of ["#example-metric .metric-label", '#example-chart-tooltip [data-group="0"] .group-label', '#example-chart-tooltip [data-group="0"] .group-median', "#example-metric strong"]) {
      await trigger.hover();
      const bounds = await page.locator(selector).evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        const r = range.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
      await page.mouse.up();
      const selected = await page.evaluate(() => getSelection().toString());
      assert.ok(selected.length > 2, `Mouse selected text in ${selector}`);
      const headline = await trigger.locator("strong").textContent();
      await page.waitForTimeout(240);
      assert.equal(await page.evaluate(() => getSelection().toString()), selected, `Selection survives refresh in ${selector}`);
      assert.equal(await page.evaluate(() => window.selectionNodes.every(([node, text]) => node.isConnected && node.firstChild === text)), true, "Heading, scalar and group text nodes are reused");
      if (!selector.endsWith("strong")) assert.notEqual(await trigger.locator("strong").textContent(), headline, "Other values stay live");
      await page.evaluate(() => getSelection().removeAllRanges());
    }
    const frozen = await trigger.locator("strong").textContent();
    await page.waitForFunction(old => document.querySelector("#example-metric strong").textContent !== old, frozen);
  } finally {
    await page.evaluate(() => { clearInterval(window.selectionTimer); getSelection().removeAllRanges(); window.componentsFixture.metric.update(-3); });
  }
  await page.mouse.move(0, 0);

  assert.deepEqual(await page.locator("#freshness-chart-tooltip .group-median").allTextContents(), ["50.0 ms", "40.0 ms"], "Freshness exposes per-group medians, using the worst member of each group");
  assert.equal(await page.locator("#freshness-example strong").first().textContent(), "50.0 ms", "Existing worst-stream freshness headline is unchanged");

  // All native controls of a given density share typography, border and height.
  const controls = await page.evaluate(() => ["default", "compact"].map(size => {
    const root = document.querySelector(`section[data-size="${size}"]`);
    return [...root.querySelectorAll('input[type="text"], input[type="number"]:not([aria-invalid]), select, button:not(:disabled)')].map(el => {
      const style = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, fontFamily: style.fontFamily, fontSize: style.fontSize, border: style.border, radius: style.borderRadius };
    });
  }));
  for (const size of controls) for (const control of size) assert.deepEqual(control, size[0]);
  assert.ok(controls[1][0].height < controls[0][0].height);
  assert.equal(await page.locator('[aria-invalid="true"]').first().evaluate(el => getComputedStyle(el).borderColor), "rgb(139, 68, 41)");
  const select = page.locator('section[data-size="default"] select');
  await select.focus();
  assert.notEqual(await select.evaluate(el => getComputedStyle(el).outlineStyle), "none");

  // Native controls retain focused drafts while live presentation refreshes.
  const editor = page.locator("subscription-editor");
  await editor.locator('[data-action="clear-bundle"]').click();
  assert.equal(await editor.locator("[data-binding-key]").count(), 0);
  await editor.locator('[data-action="select"][data-group="1"]').click();
  assert.equal(await editor.locator("[data-binding-key]").count(), 2);
  await editor.locator('[data-action="select"][data-group="0"]').click();
  await editor.locator('[data-action="discard"]').click();
  assert.equal(await editor.locator("[data-binding-key]").count(), 2);
  assert.equal(await editor.locator('[data-field="automatic"]').isChecked(), true);
  assert.equal(await editor.locator('[data-field="rate"]').getAttribute("readonly"), "");
  await editor.locator('[data-field="automatic"]').uncheck();
  await editor.locator('[data-field="rate"]').fill("42");
  await editor.locator('select[aria-label="Format for Pose"]').selectOption("11");
  await editor.locator('[data-field="rate"]').focus();
  const retained = await page.evaluate(() => {
    const editor = window.componentsFixture.editor, nodes = [...editor.querySelectorAll("*")], focus = document.activeElement;
    for (let i = 0; i < 10; i++) editor.update(performance.now());
    return document.activeElement === focus && nodes.every((node, i) => node === editor.querySelectorAll("*")[i]);
  });
  assert.equal(retained, true);
  assert.equal(await editor.locator('[data-field="rate"]').inputValue(), "42");
  await editor.locator(".subscription-timing summary").click();
  await editor.locator('[data-field="phase"]').fill("-1");
  assert.equal(await editor.locator('[data-action="apply"]').isDisabled(), true);
  assert.match(await editor.locator(".subscription-message").textContent(), /non-negative/);
  await editor.locator('[data-field="delivery"]').selectOption("2");
  assert.equal(await editor.locator('[data-action="apply"]').isDisabled(), true, "Editing another control cannot bypass an invalid timing field");
  await editor.locator('[data-field="delivery"]').selectOption("1");
  await editor.locator('[data-field="phase"]').fill("0");
  await editor.locator('[data-action="add-bundle"]').click();
  await editor.locator('[data-action="apply"]').click();
  assert.deepEqual(await page.evaluate(() => {
    const request = window.componentsFixture.requests.at(-1);
    return { group: request.group, interval: String(request.interval), samples: request.bundles[0], sequence: request.sequenceNumberFormat, bundles: request.bundles.length };
  }), { group: 0, interval: "23809524", samples: [{ descriptor: 0, format: 11, space: 1 }, { descriptor: 1, format: 1, space: 0 }], sequence: 2, bundles: 2 });
  await page.evaluate(() => {
    const state = window.componentsFixture, entry = state.editor.model.entries[0];
    state.session.receive({ tag: 6, id: entry.pendingId, reason: "Fixture rejection" });
    state.editor.update(performance.now());
  });
  assert.match(await editor.locator(".subscription-message").textContent(), /Fixture rejection/);
  assert.equal(await editor.locator('select[aria-label="Format for Pose"]').inputValue(), "11");
  await editor.locator('[data-action="discard"]').click();

  // Theme values reach HTML, SVG and Canvas, and missing samples break lines.
  const themed = await page.evaluate(() => {
    const { graph, series } = window.componentsFixture;
    document.documentElement.style.setProperty("--group-0", "#123456");
    document.documentElement.style.setProperty("--control-border", "#123456");
    const ctx = graph.canvas.getContext("2d"), moveTo = ctx.moveTo, lineTo = ctx.lineTo;
    let moves = 0, lines = 0;
    ctx.moveTo = function (...args) { moves++; return moveTo.apply(this, args); };
    ctx.lineTo = function (...args) { lines++; return lineTo.apply(this, args); };
    try { graph.update(series, 10000, 10000); } finally { ctx.moveTo = moveTo; ctx.lineTo = lineTo; }
    return {
      control: getComputedStyle(document.querySelector('subscription-editor [data-field="rate"]')).borderColor,
      svg: getComputedStyle(document.querySelector("#example-chart path")).stroke,
      table: getComputedStyle(document.querySelector("#example-example th")).color,
      canvas: ctx.strokeStyle, moves, lines,
    };
  });
  assert.deepEqual(themed, { control: "rgb(18, 52, 86)", svg: "rgb(18, 52, 86)", table: "rgb(18, 52, 86)", canvas: "#123456", moves: 5, lines: 4 });
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--group-0");
    document.documentElement.style.removeProperty("--control-border");
    const { graph, series } = window.componentsFixture; graph.update(series, 10000, 10000);
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1100 });
    await page.evaluate(() => { const { graph, series } = window.componentsFixture; graph.update(series, 10000, 10000); });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${output}${width}.png`, fullPage: true });
  }
  // Check the position of a retained observation between redraws and through the next redraw.
  const scroll = await page.evaluate(() => {
    const { chart } = window.componentsFixture, svg = document.querySelector("#example-chart");
    const series = [{ key: "measured", color: "green", value: 3 }];
    chart.reset();
    chart.update(series, 1000);
    chart.update(series, 1100);
    const path = svg.querySelector("path");
    const firstX = () => path.getPointAtLength(0).matrixTransform(path.getScreenCTM()).x;
    const a = firstX();
    chart.update(series, 1150);
    const b = firstX();
    chart.update(series, 1200);
    const c = firstX();
    return { distances: [a - b, b - c], expected: svg.getBoundingClientRect().width * 50 / 10000,
      samePath: svg.querySelector("path") === path };
  });
  assert.ok(scroll.samePath);
  for (const distance of scroll.distances) {
    assert.ok(Math.abs(distance - scroll.expected) < 0.01, `A 50 ms step moved ${distance} px, expected ${scroll.expected} px`);
  }
  assert.deepEqual(errors, []);
  await checkVisualizationChoices(page);
  console.log("PASS: shared controls, component isolation, stable drafts/focus, tooltip access, and HTML/SVG/Canvas theme consistency");
} finally { await browser.close(); }
