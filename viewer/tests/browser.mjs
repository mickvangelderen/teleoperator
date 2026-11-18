import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { checkMetricMedians, checkFrameRefresh, checkFrameRate } from "./frame-refresh.mjs";
import { checkFreshness } from "./freshness.mjs";
import { checkProtocol } from "./protocol-browser.mjs";
import { checkTrackingColors } from "./tracking-colors.mjs";
import { checkRecording } from "./recording-browser.mjs";
import { checkMultipleViewers } from "./multiple-viewers.mjs";
import { checkAutomaticPublicationTiming } from "./publication-timing.mjs";

const url = process.env.VIEWER_URL || "http://127.0.0.1:5173";
const executablePath = process.env.CHROMIUM_EXECUTABLE;
assert.ok(
  executablePath,
  "Set CHROMIUM_EXECUTABLE to a Chromium/Chrome executable",
);
const output = fileURLToPath(
  new URL("../../.artifacts/viewer/", import.meta.url),
);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1120 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(20000);
  const errors = [], consoleErrors = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => errors.push(error.message));
  const health = await (await page.request.get(new URL("/api/health", url).href)).json();
  assert.equal(health.source, "synthetic", "Browser checks require a synthetic tracking server");
  await checkMultipleViewers(browser, url);
  if (process.env.EXPECT_RECORDING === "1") await checkRecording(browser, url);
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  assert.equal(await page.locator("#poses canvas").count(), 1);
  const beforeOrbit = await page.locator("#poses").screenshot();
  const box = await page.locator("#poses canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 30, { steps: 8 }); await page.mouse.up();
  assert.notDeepEqual(await page.locator("#poses").screenshot(), beforeOrbit, "Orbit must change the rendered view");
  await page.locator("#view-angle").selectOption("front");
  assert.equal(await page.locator("#status").textContent(), "Disconnected");
  assert.equal(await page.locator("#estimated-latency").textContent(), "—");
  assert.equal(await page.locator("#sample-age").textContent(), "—");
  assert.equal(await page.locator("#freshness-age").textContent(), "—");
  assert.equal(await page.locator("#render-to-photon").inputValue(), "0");
  await page.screenshot({ path: output + "disconnected.png", fullPage: true });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => ["Connected", "Error"].includes(document.querySelector("#status").textContent),
  );
  assert.equal(
    await page.locator("#status").textContent(),
    "Connected",
    await page.locator("#error").textContent(),
  );
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "5" && document.querySelector("#poses").dataset.bodyJoints === "70");
  assert.match(await page.locator("#sample-summary").textContent(), /545 samples/);
  await page.waitForFunction(() => parseFloat(document.querySelector("#arrival-rate").textContent) > 40);
  await page.waitForFunction(() => document.querySelector("#estimated-latency").textContent.endsWith(" ms") && document.querySelector("#sample-age").textContent.endsWith(" ms"));
  assert.equal(await page.locator(".metric").filter({ has: page.locator("#sample-age") }).locator(".metric-label").textContent(), "SAMPLE AGE AT PHOTON");
  assert.equal(await page.locator(".metric").filter({ has: page.locator("#estimated-latency") }).locator(".metric-label").textContent(), "NETWORK LATENCY");
  assert.equal(await page.getByRole("heading", { name: "Transport details" }).count(), 0);
  const workspace = await page.locator(".workspace").boundingBox(), metrics = await page.locator(".metrics").boundingBox();
  assert.equal(workspace.width, metrics.width, "Tracking workspace uses the full available width");
  assert.match(await page.locator("#subscription-3").textContent(), /on change · [\d.]+ Hz slots · reliable · \d+ packets/g);
  assert.equal(await page.locator("#rate-3").isVisible(), true);
  await page.locator("#delivery-3").selectOption("1");
  assert.equal(await page.locator("#rate-3").isVisible(), true, "Channel does not choose the schedule");
  await page.locator("#schedule-3").selectOption("continuous");
  assert.equal(await page.locator("#rate-3").isVisible(), true);
  await page.locator("#schedule-3").selectOption("onChange");
  await page.locator("#delivery-3").selectOption("2");
  await page.locator("#skeleton-view").selectOption("rest");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70" && document.querySelector("#poses").dataset.poseCount === "0");
  assert.match(await page.locator("#body-quality").textContent(), /skeleton rest frame/);
  await page.locator("#skeleton-view").selectOption("live");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "5");
  await checkAutomaticPublicationTiming(page);
  await checkFrameRefresh(page);
  await checkTrackingColors(page, output);
  await checkFreshness(page, output);
  assert.match(await page.locator("#requested-prediction-offset").textContent(), /^Requested: [\d.]+ ms$/);
  assert.match(await page.locator("#measured-prediction-offset").textContent(), /^Device target − acquisition: (?:-?[\d.]+ ms|unavailable)$/);
  await checkMetricMedians(page);
  assert.match(await page.locator("#subscription-3").textContent(), /on change · [\d.]+ Hz slots · reliable · \d+ packets/g, "Acknowledged rest remains active without periodic refresh");
  await page.locator("#skeleton-view").selectOption("rest");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70" && document.querySelector("#poses").dataset.poseCount === "0");
  await page.locator('[data-descriptor="/body/FB/rest/revision"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-descriptor="/body/FB/rest/revision"] .sample-value').textContent === "1 · retained");
  await page.locator("#skeleton-view").selectOption("live");
  const button = page.locator('[data-descriptor="/user/hand/left/input/x/click"]');
  await button.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => /true|false/.test(document.querySelector('[data-descriptor="/user/hand/left/input/x/click"] .sample-value').textContent));
  assert.equal(await button.locator('input[type="checkbox"]').isChecked(), true);
  await page.locator('[data-descriptor="/user/head/input/pose"] select').first().selectOption("11");
  await page.locator("#automatic-0").uncheck();
  await page.locator("#rate-0").fill("30");
  await page.locator("#delivery-0").selectOption("2");
  const beforeReplacement = (await page.locator("#subscription-0").textContent()).match(/Subscription (\d+)/)[1];
  await page.locator("#publish-0").click();
  await page.waitForFunction(previous => {
    const text = document.querySelector("#subscription-0").textContent;
    return !text.startsWith(`Subscription ${previous} ·`) && text.includes("30.0 Hz target");
  }, beforeReplacement);
  const headGeneration = (await page.locator("#subscription-0").textContent()).match(/Subscription (\d+)/)[1];
  const measuredRate = await page.evaluate(async () => {
    const count = () => Number(document.querySelector("#subscription-0").textContent.match(/(\d+) packets/)[1]);
    const before = count(), start = performance.now();
    await new Promise(resolve => setTimeout(resolve, 1200));
    return (count() - before) * 1000 / (performance.now() - start);
  });
  assert.ok(measuredRate > 20 && measuredRate < 40, `Head group requested 30 Hz, received ${measuredRate}`);
  await page.locator("#rate-0").fill("0.000000000000000000000000000001");
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => /rejected|not sent/.test(document.querySelector("#publication-status").textContent));
  assert.ok((await page.locator("#subscription-0").textContent()).startsWith(`Subscription ${headGeneration} ·`));
  await page.locator("#rate-0").fill("60");
  await page.locator("#delivery-0").selectOption("1");
  for (const group of [0, 1, 2]) await page.locator(".subscription-group").nth(group).getByRole("button", { name: "Clear selection" }).click();
  for (const id of ["/user/head/input/pose", "/body/FB/7", "/user/hand/left/input/trigger/value", "/user/head/input/pose/position_valid", "/user/head/input/pose/orientation_valid", "/body/FB/7/position_valid", "/body/FB/7/orientation_valid"]) await page.locator(`[data-descriptor="${id}"] input[type="checkbox"]`).check();
  for (const group of [0, 1, 2]) await page.locator(`#publish-${group}`).click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "1" && document.querySelector("#poses").dataset.bodyJoints === "1" && document.querySelector("#subscription-0").textContent.includes("3 samples"));
  for (const [group, count] of [[0, 3], [1, 1], [2, 3]]) assert.ok((await page.locator(`#subscription-${group}`).textContent()).includes(`${count} samples`));
  await button.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-descriptor="/user/hand/left/input/x/click"] .sample-value').textContent === "Not subscribed");
  await page.screenshot({ path: output + "individual-joint.png", fullPage: true });
  for (const group of [0, 1, 2]) await page.locator(`#stop-${group}`).click();
  await page.waitForFunction(() => document.querySelector("#subscription-0").textContent === "No active publication" && document.querySelector("#poses").dataset.bodyJoints === "0" && document.querySelector("#poses").dataset.poseCount === "0");
  assert.equal(await page.locator("#sample-age").textContent(), "—", "No live samples means no sample age");
  await page.waitForFunction(() => document.querySelector("#estimated-latency").textContent.endsWith(" ms"));
  for (const group of [0, 1, 2]) await page.locator(`#publish-${group}`).click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "1");
  for (const group of [0, 1, 2]) {
    await page.locator(".subscription-group").nth(group).getByRole("button", { name: "Select all", exact: true }).click();
    await page.locator(`#publish-${group}`).click();
  }
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70");
  const restGeneration = (await page.locator("#subscription-3").textContent()).match(/Subscription (\d+)/)[1];
  await page.locator('[data-descriptor="/body/FB/rest/revision"] input[type="checkbox"]').uncheck();
  await page.locator("#publish-3").click();
  await page.waitForFunction(previous => {
    const text = document.querySelector("#subscription-3").textContent;
    return !text.startsWith(`Subscription ${previous} ·`) && /on change.*reliable.*[1-9]\d* packets/.test(text);
  }, restGeneration);
  // More reconnects than the peer limit catches slots leaked by a closed session.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForFunction(
      () => ["Connected", "Error"].includes(document.querySelector("#status").textContent),
    );
    assert.equal(
      await page.locator("#status").textContent(),
      "Connected",
      await page.locator("#error").textContent(),
    );
  }
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "5" && document.querySelector("#poses").dataset.bodyJoints === "70");
  assert.match(await page.locator("#publication-status").textContent(), /accepted/);
  await page.waitForFunction(() => parseFloat(document.querySelector("#arrival-rate").textContent) > 40);
  await page.screenshot({ path: output + "connected.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => ["Connected", "Error"].includes(document.querySelector("#status").textContent),
  );
  assert.equal(
    await page.locator("#status").textContent(),
    "Connected",
    await page.locator("#error").textContent(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "Mobile layout must not overflow",
  );
  await page.screenshot({ path: output + "mobile.png", fullPage: true });
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
  assert.deepEqual(consoleErrors, [], "No browser console errors during normal operation");
  await checkProtocol(page);
  await page.route("**/api/offer", (route) =>
    route.fulfill({ status: 503, body: "Device unavailable" }),
  );
  await checkFrameRate(page);
  await page.route("**/assets/meta/headset.glb", route => route.fulfill({ status: 404, body: "Missing asset" }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#graphics-status").textContent.includes("could not load"));
  assert.match(await page.locator("#graphics-status").textContent(), /could not load/);
  assert.equal(await page.getByRole("button", { name: "Connect" }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: v1 WebRTC negotiation/capabilities, all device poses/inputs/70 joints, reliable/unreliable delivery, clock estimates, change-driven rest retention and replacement, f64/rate/selection replacement, rejection, individual joint rendering, unsubscribe/resubscribe, fresh reconnects, WebGL/orbit, mobile layout, signaling and asset failures. Captures: ${output}`,
  );
} finally {
  await browser.close();
}
