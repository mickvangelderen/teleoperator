import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const url = process.env.VIEWER_URL || "http://127.0.0.1:5173";
const executablePath = process.env.CHROMIUM_EXECUTABLE;
assert.ok(executablePath, "Set CHROMIUM_EXECUTABLE to Chrome/Chromium");
const output = new URL("../../.artifacts/performance/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1120 } });
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(20000);
  // Simulate a lost acknowledgement: the retry must not duplicate the saved batch.
  let lostAck = false;
  await page.route("**/__dev/recordings/*", async route => {
    if (!lostAck) {
      lostAck = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  await page.waitForFunction(() => document.querySelector("#recording-status").textContent.startsWith("Recording ·"));
  assert.equal(await page.locator("#profile-results").isVisible(), false);
  await page.getByRole("button", { name: /^Connect/ }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected" && Number(document.querySelector("#poses").dataset.poseCount) > 0);
  await page.getByRole("button", { name: "Show live timings" }).click();
  await page.waitForFunction(() => ["interval", "ui", "render", "receive"].every(key => document.querySelector(`#timing-${key} [data-stat='current']`).textContent !== "—"));
  // A stall outside our callbacks must still appear in the render interval.
  await page.evaluate(() => { const until = performance.now() + 160; while (performance.now() < until) {} });
  await page.waitForFunction(() => Number(document.querySelector("#timing-interval [data-stat='max']").textContent) >= 150);
  await page.getByRole("button", { name: "Pause chart" }).click();
  const frozen = await page.locator(".timing-summary").textContent();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download chart" }).click();
  const download = await downloadPromise;
  await download.saveAs(new URL("chart.json", output).pathname);
  const chart = JSON.parse(await readFile(new URL("chart.json", output), "utf8"));
  assert.ok(chart.metrics.find(m => m.key === "interval").summary.max >= 150);
  const pausedAt = chart.end;
  const chartStartedAt = chart.metrics.find(m => m.key === "ui").samples[0].at;
  await page.getByLabel("Viewer consumer").selectOption("5");
  await page.waitForTimeout(1200);
  assert.equal(await page.locator(".timing-summary").textContent(), frozen, "Paused chart must remain frozen");
  await page.getByRole("button", { name: "Show live timings" }).click();
  await page.waitForTimeout(1500);
  const interval = Number(await page.locator("#timing-interval [data-stat='median']").textContent());
  assert.ok(interval > 120 && interval < 300, `Slow-consumer interval: ${interval} ms`);
  await page.locator("#performance").screenshot({ path: new URL("panel.png", output).pathname });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator("#performance").screenshot({ path: new URL("mobile.png", output).pathname });
  await page.getByRole("button", { name: "Save and stop recording" }).click();
  await page.waitForFunction(() => document.querySelector("#recording-status").textContent.startsWith("Recording saved"));
  const status = await page.locator("#recording-status").textContent();
  const file = status.match(/[0-9a-f-]{36}\.jsonl/)[0];
  const contents = await readFile(new URL(`../../.artifacts/recordings/${file}`, import.meta.url), "utf8");
  const records = contents.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(records.slice(1).map(record => record.sequence), Array.from({ length: records.length - 1 }, (_, i) => i));
  assert.equal(records.at(-1).type, "recording-end");
  const packets = records.filter(r => r.type === "packet");
  assert.ok(packets.filter(p => p.direction === "sent").length >= 5);
  assert.ok(packets.filter(p => p.direction === "received").length > 100);
  for (const packet of packets) {
    const bytes = Buffer.from(packet.base64, "base64");
    assert.equal(bytes.length, packet.length);
    assert.equal(bytes.subarray(4, 8).toString(), "XROP");
  }
  for (const metric of ["interval", "ui", "render", "receive"]) assert.ok(records.some(r => r.type === "timing" && r.metric === metric));
  assert.ok(records.some(r => r.type === "timing" && r.atMs > pausedAt && r.atMs < pausedAt + 1000), "Disk timings continue with the chart paused");
  assert.ok(records.some(r => r.type === "timing" && r.atMs < chartStartedAt), "Default recording precedes chart capture");
  const gpu = records.filter(r => r.type === "timing" && r.metric === "gpu");
  console.log(gpu.length ? `GPU query samples: ${gpu.length} (headless browser; not a hardware benchmark)` : "SKIP: GPU query readback unavailable in this browser; fallback is tested separately");
  await writeFile(new URL("result.json", output), JSON.stringify({ file, events: records.length, packets: packets.length, gpuSamples: gpu.length, slowIntervalMs: interval }, null, 2));
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.close();

  const fallback = await browser.newPage();
  await fallback.addInitScript(() => {
    const original = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function(name) { return name === "EXT_disjoint_timer_query_webgl2" ? null : original.call(this, name); };
  });
  fallback.on("pageerror", error => errors.push(error.message));
  await fallback.goto(url);
  await fallback.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  await fallback.getByRole("button", { name: "Show live timings" }).click();
  await fallback.waitForFunction(() => document.querySelector("#profiling-status").textContent.includes("GPU timing unavailable"));
  // A failed recording endpoint must be visible without disabling the Viewer.
  await fallback.route("**/__dev/recordings/*", route => route.fulfill({ status: 507, contentType: "application/json", body: JSON.stringify({ error: "Test storage limit reached" }) }));
  await fallback.locator("#view-angle").selectOption("front");
  await fallback.waitForFunction(() => document.querySelector("#recording-status").textContent.includes("Recording incomplete"));
  assert.match(await fallback.locator("#recording-status").textContent(), /storage limit/);
  assert.equal(await fallback.getByRole("button", { name: /^Connect/ }).isEnabled(), true);
  await fallback.close();

  const overflow = await browser.newPage();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await overflow.route("**/__dev/recordings/*", async route => {
    await blocked;
    await route.fulfill({ status: 507, contentType: "application/json", body: JSON.stringify({ error: "Test writer stalled" }) });
  });
  await overflow.goto(url);
  await overflow.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  await overflow.evaluate(async () => {
    const { recording } = await import("/src/recording.ts");
    for (let i = 0; i < 40; i++) recording.add({ type: "test-backlog", text: "x".repeat(60_000) });
  });
  await overflow.waitForFunction(() => document.querySelector("#recording-status").textContent.includes("queue exceeded 4 MiB"));
  assert.equal(await overflow.getByRole("button", { name: /^Connect/ }).isEnabled(), true);
  release();
  await overflow.close();
  assert.deepEqual(errors, []);
  console.log("PASS: default packet/performance recording, idempotent retry, chart stall/pause/export, slow consumer, mobile layout, GPU fallback, disk failure and bounded recording backlog");
} finally { await browser.close(); }
