import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  assert.equal(await page.locator("#status").textContent(), "Disconnected");
  await page.screenshot({ path: output + "disconnected.png", fullPage: true });
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent !== "Connecting",
  );
  assert.equal(
    await page.locator("#status").textContent(),
    "Connected",
    await page.locator("#error").textContent(),
  );
  await page.waitForFunction(() =>
    /^\d+\.\d$/.test(document.querySelector("#rtt").textContent),
  );
  // More reconnects than the peer limit catches slots leaked by a closed session.
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForFunction(
      () => document.querySelector("#status").textContent !== "Connecting",
    );
    assert.equal(
      await page.locator("#status").textContent(),
      "Connected",
      await page.locator("#error").textContent(),
    );
    await page.waitForFunction(() =>
      /^\d+\.\d$/.test(document.querySelector("#rtt").textContent),
    );
  }
  assert.equal(await page.locator("#version").textContent(), "1");
  assert.equal(await page.locator("#control").textContent(), "Open");
  assert.equal(await page.locator("#tracking").textContent(), "Open");
  assert.equal(
    await page.locator("#source-count").textContent(),
    "0 advertised",
  );
  const session = await page.locator("#session-id").textContent();
  assert.match(session, /^[a-f0-9]{16} [a-f0-9]{16}$/);
  await page.getByRole("button", { name: /Inspect ServerHello/ }).click();
  assert.match(
    await page.locator("#payload").textContent(),
    /"selectedVersion": 1/,
  );
  await page.screenshot({ path: output + "connected.png", fullPage: true });
  await page.getByLabel("Show clock probes").check();
  assert.ok(
    (await page.getByRole("button", { name: /Inspect ClockReply/ }).count()) >
      0,
  );
  await page.getByLabel("Show clock probes").uncheck();
  await page.getByRole("button", { name: "Disconnect" }).click();
  assert.equal(
    await page.locator("#session-id").textContent(),
    "No session established",
  );
  assert.equal(await page.locator("#rtt").textContent(), "—");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => document.querySelector("#status").textContent !== "Connecting",
  );
  assert.equal(
    await page.locator("#status").textContent(),
    "Connected",
    await page.locator("#error").textContent(),
  );
  assert.equal(
    await page.locator("#session-id").textContent(),
    session,
    "App session persists across peer reconnects",
  );
  await page.waitForFunction(() =>
    /^\d+\.\d$/.test(document.querySelector("#rtt").textContent),
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
  assert.equal(
    await page.locator("#session-id").textContent(),
    "No session established",
  );
  assert.deepEqual(errors, []);
  console.log(
    `PASS: live hello, discovery, clock replies, reconnect, mobile layout and signaling failure. Captures: ${output}`,
  );
} finally {
  await browser.close();
}
