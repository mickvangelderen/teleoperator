import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { checkMetricMedians, checkFrameRefresh } from "./frame-refresh.mjs";
import { checkFreshness } from "./freshness.mjs";
import { checkTrackingColors } from "./tracking-colors.mjs";

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
  assert.equal(await page.locator("#render-to-photon").inputValue(), "20");
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
  assert.match(await page.locator("#sample-summary").textContent(), /517 samples/);
  await page.waitForFunction(() => parseFloat(document.querySelector("#arrival-rate").textContent) > 40);
  await page.waitForFunction(() => document.querySelector("#estimated-latency").textContent.endsWith(" ms") && document.querySelector("#sample-age").textContent.endsWith(" ms"));
  assert.equal(await page.locator(".metric").filter({ has: page.locator("#sample-age") }).locator("label").textContent(), "SAMPLE AGE AT PHOTON");
  assert.equal(await page.locator(".metric").filter({ has: page.locator("#estimated-latency") }).locator("label").textContent(), "NETWORK LATENCY");
  assert.equal(await page.getByRole("heading", { name: "Transport details" }).count(), 0);
  const workspace = await page.locator(".workspace").boundingBox(), metrics = await page.locator(".metrics").boundingBox();
  assert.equal(workspace.width, metrics.width, "Tracking workspace uses the full available width");
  assert.match(await page.locator("#subscription-1").textContent(), /on change · reliable · 1 packets/);
  assert.equal(await page.locator("#rate-1").isVisible(), false);
  await page.locator("#delivery-1").selectOption("1");
  assert.equal(await page.locator("#rate-1").isVisible(), true);
  await page.locator("#delivery-1").selectOption("2");
  await page.locator("#skeleton-view").selectOption("rest");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70" && document.querySelector("#poses").dataset.poseCount === "0");
  assert.match(await page.locator("#body-quality").textContent(), /skeleton rest frame/);
  await page.locator("#skeleton-view").selectOption("live");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "5");
  await checkFrameRefresh(page);
  await checkTrackingColors(page, output);
  await checkFreshness(page, output);
  assert.equal(await page.locator("#prediction-horizon").textContent(), "Prediction horizon: 25 ms");
  await checkMetricMedians(page);
  assert.match(await page.locator("#subscription-1").textContent(), /on change · reliable · 1 packets/, "Unchanged rest poses are sent only once");
  await page.locator("#skeleton-view").selectOption("rest");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70" && document.querySelector("#poses").dataset.poseCount === "0");
  assert.match(await page.locator('[data-descriptor="/body/FB/rest/revision"] .sample-value').textContent(), /^1$/);
  await page.locator("#skeleton-view").selectOption("live");
  const button = page.locator('[data-descriptor="/user/hand/left/input/x/click"]');
  await page.waitForFunction(() => /true|false/.test(document.querySelector('[data-descriptor="/user/hand/left/input/x/click"] .sample-value').textContent));
  assert.equal(await button.locator('input[type="checkbox"]').isChecked(), true);
  await page.locator('[data-descriptor="/user/head/input/pose"] select').first().selectOption("11");
  await page.locator("#rate-0").fill("30");
  await page.locator("#delivery-0").selectOption("2");
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => document.querySelector("#subscription-0").textContent.includes("generation 3") || document.querySelector("#subscription-0").textContent.includes("Generation 3"));
  await page.waitForFunction(() => { const n=parseFloat(document.querySelector("#arrival-rate").textContent); return n >= 20 && n < 40; });
  await page.locator("#rate-0").fill("0.000000000000000000000000000001");
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => document.querySelector("#publication-status").textContent.includes("rejected"));
  assert.match(await page.locator("#subscription-0").textContent(), /Generation 3/);
  await page.locator("#rate-0").fill("60");
  await page.locator("#delivery-0").selectOption("1");
  await page.getByRole("button", { name: "Clear selection" }).first().click();
  for (const id of ["/user/head/input/pose", "/body/FB/7", "/user/hand/left/input/trigger/value", "/user/head/input/pose/position_valid", "/user/head/input/pose/orientation_valid", "/body/FB/7/position_valid", "/body/FB/7/orientation_valid"]) await page.locator(`[data-descriptor="${id}"] input[type="checkbox"]`).check();
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "1" && document.querySelector("#poses").dataset.bodyJoints === "1" && document.querySelector("#subscription-0").textContent.includes("7 samples"));
  assert.match(await page.locator("#subscription-0").textContent(), /7 samples/);
  assert.equal(await button.locator(".sample-value").textContent(), "Not subscribed");
  await page.screenshot({ path: output + "individual-joint.png", fullPage: true });
  await page.locator("#stop-0").click();
  await page.waitForFunction(() => document.querySelector("#subscription-0").textContent === "No active publication" && document.querySelector("#poses").dataset.bodyJoints === "0" && document.querySelector("#poses").dataset.poseCount === "0");
  assert.equal(await page.locator("#sample-age").textContent(), "—", "No live samples means no sample age");
  await page.waitForFunction(() => document.querySelector("#estimated-latency").textContent.endsWith(" ms"));
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "1");
  await page.getByRole("button", { name: "Select all", exact: true }).first().click();
  await page.locator("#publish-0").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyJoints === "70");
  const restGeneration = (await page.locator("#subscription-1").textContent()).match(/Generation (\d+)/)[1];
  await page.locator("#publish-1").click();
  await page.waitForFunction(previous => {
    const text = document.querySelector("#subscription-1").textContent;
    return !text.startsWith(`Generation ${previous} ·`) && text.includes("on change · reliable · 1 packets");
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
  if (process.env.EXPECT_RECORDING === "1") {
    assert.match(await page.locator("#recording-status").getAttribute("title"), /MiB saved/);
    assert.equal(await page.locator("#recording-status").getAttribute("class"), "tag");
  }
  await page.route("**/api/offer", (route) =>
    route.fulfill({ status: 503, body: "Device unavailable" }),
  );
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent === "Error",
  );
  assert.match(
    await page.locator("#error").textContent(),
    /Signaling failed \(503\)/,
  );
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
