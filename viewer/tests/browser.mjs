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
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  assert.equal(await page.locator("#poses canvas").count(), 1);
  const beforeOrbit = await page.locator("#poses").screenshot();
  const box = await page.locator("#poses canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 30, { steps: 8 }); await page.mouse.up();
  assert.notDeepEqual(await page.locator("#poses").screenshot(), beforeOrbit, "Orbit must change the rendered view");
  await page.locator("#view-angle").selectOption("front");
  assert.equal(await page.locator("#status").textContent(), "Disconnected");
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
  await page.waitForFunction(() =>
    /^\d+\.\d$/.test(document.querySelector("#rtt").textContent),
  );
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
    await page.waitForFunction(() =>
      /^\d+\.\d$/.test(document.querySelector("#rtt").textContent),
    );
  }
  assert.equal(await page.locator("#version").textContent(), "2");
  assert.equal(await page.locator("#control").textContent(), "Open");
  assert.equal(await page.locator("#tracking").textContent(), "Open");
  assert.equal(
    await page.locator("#source-count").textContent(),
    process.env.EXPECT_TRACKING === "1" ? "8 advertised" : "0 advertised",
  );
  const session = await page.locator("#session-id").textContent();
  assert.match(session, /^[a-f0-9]{16} [a-f0-9]{16}$/);
  await page.getByRole("button", { name: /Inspect ServerHello/ }).click();
  await page.waitForFunction(() => document.querySelector("#payload").textContent.includes('"selectedVersion": 2'));
  assert.match(
    await page.locator("#payload").textContent(),
    /"selectedVersion": 2/,
  );
  await page.screenshot({ path: output + "connected.png", fullPage: true });
  await page.getByLabel("Show clock probes").check();
  await page.getByRole("button", { name: /Inspect ClockReply/ }).first().waitFor();
  assert.ok(
    (await page.getByRole("button", { name: /Inspect ClockReply/ }).count()) >
      0,
  );
  await page.getByLabel("Show clock probes").uncheck();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
  assert.equal(
    await page.locator("#session-id").textContent(),
    "No session established",
  );
  assert.equal(await page.locator("#rtt").textContent(), "—");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(
    () => ["Connected", "Error"].includes(document.querySelector("#status").textContent),
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
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
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
  await page.route("**/assets/meta/headset.glb", route => route.fulfill({ status: 404, body: "Missing asset" }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector("#graphics-status").textContent.includes("could not load"));
  assert.match(await page.locator("#graphics-status").textContent(), /could not load/);
  assert.equal(await page.getByRole("button", { name: "Connect" }).isEnabled(), true);
  assert.deepEqual(errors, []);
  console.log(
    `PASS: live hello, discovery, clock replies, reconnect, WebGL models/orbit, mobile layout, signaling and asset failures. Captures: ${output}`,
  );
} finally {
  await browser.close();
}
