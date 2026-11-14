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
  const trigger = page.locator("#example-chart"), tooltip = page.locator("#example-chart-tooltip");
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

  // Group selection is local; presentation updates preserve focus and draft values.
  await page.locator("publication-group").first().getByRole("button", { name: "Clear selection" }).click();
  assert.equal(await page.locator("publication-group").first().locator('input[type="checkbox"]:checked').count(), 0);
  assert.equal(await page.locator("publication-group").nth(1).locator('input[type="checkbox"]:checked').count(), 2);
  await page.locator("publication-group").first().getByRole("button", { name: "Select all" }).click();
  await page.locator("#rate-0").fill("42");
  await page.locator("publication-group").first().locator('select[aria-label="Format for Pose"]').selectOption("11");
  await page.locator("#rate-0").focus();
  const retained = await page.evaluate(() => {
    const group = window.componentsFixture.groups[0], nodes = [...group.querySelectorAll("*")], focus = document.activeElement;
    for (let i = 0; i < 10; i++) group.update(undefined, false, new Map());
    return document.activeElement === focus && nodes.every((node, i) => node === group.querySelectorAll("*")[i]);
  });
  assert.equal(retained, true);
  assert.equal(await page.locator("#rate-0").inputValue(), "42");
  await page.locator("#publish-0").click();
  assert.deepEqual(await page.evaluate(() => {
    const request = window.componentsFixture.requests.at(-1);
    return { group: request.group, interval: String(request.schedule.interval), samples: request.samples };
  }), { group: 0, interval: "23809524", samples: [{ descriptor: 0, format: 11, space: 1 }, { descriptor: 1, format: 1, space: 0 }] });
  await page.locator("#phase-0").fill("-1");
  await page.locator("#publish-0").click();
  assert.equal(await page.evaluate(() => window.componentsFixture.requests.length), 1);
  assert.match(await page.evaluate(() => window.componentsFixture.errors[0]), /Invalid duration/);
  await page.locator("#phase-0").fill("0");
  await page.locator("#schedule-0").selectOption("onChange");
  assert.equal(await page.locator("#rate-0").isVisible(), false);
  await page.locator("#publish-0").click();
  assert.equal(await page.evaluate(() => window.componentsFixture.requests.at(-1).schedule.kind), "onChange");

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
      control: getComputedStyle(document.querySelector("#rate-0")).borderColor,
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
  assert.deepEqual(errors, []);
  console.log("PASS: shared controls, component isolation, stable drafts/focus, tooltip access, and HTML/SVG/Canvas theme consistency");
} finally { await browser.close(); }
