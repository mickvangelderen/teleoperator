import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { chromium } from "playwright-core";

// Isolated UI validation: no operator server, no connection to a running viewer.
const port = Number(process.env.VIEWER_TEST_PORT ?? 5174), url = `http://127.0.0.1:${port}`;
assert.ok(port !== 5173 && Number.isInteger(port) && port > 0 && port < 65536);
const server = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)), env: { ...process.env, XR_OPERATOR_URL: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"],
});
let output = "", browser;
server.stdout.on("data", data => { output = (output + data).slice(-8192); });
server.stderr.on("data", data => { output = (output + data).slice(-8192); });
const exited = new Promise(resolve => server.once("exit", resolve));
try {
  const deadline = Date.now() + 10000;
  while (true) {
    assert.equal(server.exitCode, null, output);
    assert.ok(Date.now() < deadline, `Private viewer did not start: ${output}`);
    try { if (output.includes(`:${port}/`) && (await fetch(url)).ok) break; } catch { /* Wait for our private listener. */ }
    await pause(50);
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE ?? "/opt/google/chrome/chrome", headless: true });
  await mkdir(fileURLToPath(new URL("../../.artifacts/viewer/dashboard/", import.meta.url)), { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    // Drive the browser UI independently of services on the developer's LAN.
    window.EventSource = class {
      constructor() { window.testDiscovery = this; this.closed = false; }
      snapshot(endpoints) { this.onmessage({ data: JSON.stringify(endpoints) }); }
      close() { this.closed = true; }
    };
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  assert.equal(await page.title(), "Teleoperator protocol");
  assert.equal(await page.locator("header .brand").innerText(), "×\nTeleoperator protocol");
  assert.equal(await page.getByRole("heading", { level: 1 }).count(), 1);
  assert.equal(await page.getByRole("heading", { name: "Teleoperator protocol", level: 1 }).count(), 1);
  assert.equal(await page.locator(".page-heading, .header-note, footer").count(), 0);
  assert.doesNotMatch(await page.locator("body").innerText(), /A window into your device|DEVICE OBSERVABILITY|OPERATOR \/ CONNECTION/);
  assert.equal(await page.locator("header #connect").count(), 1);
  const dialog = page.getByRole("dialog", { name: "Choose an operator" });
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await dialog.getByLabel("Operator address").inputValue(), "http://127.0.0.1:1");
  assert.equal(await page.locator("header #status").textContent(), "Disconnected");
  assert.equal(await page.locator("#render-to-photon").inputValue(), "0");
  await page.keyboard.press("Tab");
  assert.equal(await dialog.getByRole("button", { name: "Close operator picker" }).evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), false);
  assert.equal(await page.evaluate(() => window.testDiscovery.closed), true);
  assert.equal(await page.locator("#choose-operator").evaluate(el => el === document.activeElement), true);
  await page.keyboard.press("Enter");
  assert.equal(await dialog.isVisible(), true);

  // Real Session decoding/consumption and dashboard rendering with independent
  // synthetic input publications; the fixture never opens an operator connection.
  await page.evaluate(async () => {
    const { Connection } = await import("/src/connection.ts");
    const { timing } = await import("/src/protocol.ts");
    const { GroupMetrics } = await import("/src/group-metrics.ts");
    const measure = GroupMetrics.prototype.update;
    GroupMetrics.prototype.update = function (...args) { return window.frameMetrics = measure.apply(this, args); };
    const connect = Connection.prototype.connect, close = Connection.prototype.close;
    Connection.prototype.connect = async function () {
      const session = this.session;
      session.receive({ tag: 2, version: 1 });
      session.receive({ tag: 3, capabilities: { groups: [200, 200, 200], skeletons: [], descriptors: [0, 1, 2].map(group => ({ id: `input-${group}`, name: `Input ${group}`, description: "", group, kind: 2, formats: [1], spaces: [] })) } });
      session.clockEstimate = now => ({ offset: 0n, delay: 100000n, at: now });
      for (let group = 0; group < 3; group++) {
        const binding = [{ descriptor: group, format: 1, space: 0 }];
        session.request({ id: group + 1, group, delivery: 1, ...timing(60), sequenceNumberFormat: 2, bundles: group === 2 ? [[], binding] : [binding] });
        session.receive({ tag: 5, id: group + 1 });
      }
      let sequence = 0;
      const fixture = window.dashboardFixture = { session, ages: [20, 80], acquiredAges: [0, 0], missingTargets: [false, false], paused: false };
      const publish = () => {
        const now = performance.now();
        for (const group of [0, 1]) {
          if (group === 1 && fixture.paused) continue;
          const bytes = new Uint8Array(25), view = new DataView(bytes.buffer);
          view.setUint32(0, group + 1, true); view.setBigUint64(4, BigInt(Math.round((now - fixture.acquiredAges[group]) * 1e6)), true);
          view.setBigUint64(12, fixture.missingTargets[group] ? 0xffffffffffffffffn : BigInt(Math.round((now - fixture.ages[group]) * 1e6)), true); view.setUint32(20, sequence, true); bytes[24] = 1;
          session.tracking(bytes, now);
          session.active.get(group + 1).arrivals = Array(group ? 20 : 60).fill(now);
        }
        sequence++;
      };
      fixture.publish = publish;
      publish(); this.fixtureTimer = setInterval(publish, 20);
      this.state.status = "Connected"; this.state.detail = "UI metric fixture"; this.update(this.state);
    };
    Connection.prototype.close = function () { clearInterval(this.fixtureTimer); close.call(this); };
    window.restoreDashboard = () => { Connection.prototype.connect = connect; Connection.prototype.close = close; GroupMetrics.prototype.update = measure; };
  });
  await dialog.getByRole("button", { name: "Connect" }).click();
  await page.waitForFunction(() => document.querySelector("#arrival-rate").textContent === "40.0 Hz");
  await page.waitForTimeout(2100);
  assert.equal(await page.locator("header #status").textContent(), "Connected");
  const age = parseFloat(await page.locator("#sample-age").textContent());
  assert.ok(age >= 50 && age < 85, `Input group age mean: ${age}`);
  assert.equal(await page.locator("#age-chart path").count(), 2);
  assert.equal(await page.locator(".arrival-actual-line").count(), 3);
  const ageColors = await page.locator("#age-chart path").evaluateAll(lines => lines.map(e => e.getAttribute("stroke")));
  assert.equal(new Set(ageColors).size, 2);
  assert.deepEqual(ageColors, (await page.locator(".arrival-actual-line").evaluateAll(lines => lines.map(e => e.getAttribute("stroke")))).slice(0, 2));
  await page.locator("#age-metric").focus();
  assert.equal(await page.locator("#age-chart-tooltip").isVisible(), true);
  assert.match(await page.locator("#age-chart-tooltip").textContent(), /mean of available 2 s group medians/);
  await page.keyboard.press("Escape");
  await page.locator("header #connect").focus();
  assert.equal(await page.locator("#freshness .metric-label").textContent(), "SAMPLE FRESHNESS");
  await page.evaluate(() => {
    window.dashboardFixture.acquiredAges = [20, 20]; window.dashboardFixture.ages = [10, 10];
  });
  for (const delay of [5, 0, 30]) {
    await page.locator("#render-to-photon").fill(String(delay));
    await page.waitForFunction(delay => window.frameMetrics.groups.slice(0, 2).every(g => Math.abs(g.age - g.freshness - (delay - 10)) < 0.00001), delay);
    await page.waitForTimeout(2100);
    const values = await page.evaluate(() => ({ freshness: parseFloat(document.querySelector("#freshness-age").textContent), age: parseFloat(document.querySelector("#sample-age").textContent) }));
    assert.ok(Math.abs(values.age - values.freshness - (delay - 10)) < 0.1, `Actual displayed endpoints differ only by represented offset and photon delay: ${JSON.stringify(values)}`);
  }
  await page.locator("#freshness .metric-label").hover();
  assert.match(await page.locator("#freshness-chart-tooltip").textContent(), /acquisition → use for frame computation/);
  assert.match(await page.locator("#freshness-chart-tooltip").textContent(), /No render-to-photon delay/);
  await page.screenshot({ path: fileURLToPath(new URL("../../.artifacts/viewer/dashboard/sample-freshness-tooltip.png", import.meta.url)) });
  await page.locator("#age-metric .metric-label").hover();
  assert.match(await page.locator("#age-chart-tooltip").textContent(), /Effect time = frame computation time \+ render-to-photon delay/);
  await page.screenshot({ path: fileURLToPath(new URL("../../.artifacts/viewer/dashboard/sample-age-tooltip.png", import.meta.url)) });
  await page.evaluate(() => { window.dashboardFixture.missingTargets[1] = true; });
  await page.waitForFunction(() => window.frameMetrics.groups[1].medianAge === undefined && Number.isFinite(window.frameMetrics.groups[1].medianFreshness));
  assert.equal(await page.locator('#age-chart-tooltip [data-group="1"] .group-median').textContent(), "—");
  assert.match(await page.locator('#freshness-chart-tooltip [data-group="1"] .group-median').textContent(), /ms$/);
  await page.locator("#render-to-photon").fill("0");
  await page.evaluate(() => { window.dashboardFixture.missingTargets = [false, false]; window.dashboardFixture.acquiredAges = [0, 0]; window.dashboardFixture.ages = [20, 80]; });
  await page.waitForTimeout(2100);
  await page.mouse.move(0, 0); await page.locator("header #connect").focus();
  const pulse = await page.evaluate(async () => {
    const { GroupMetrics } = await import("/src/group-metrics.ts");
    const update = GroupMetrics.prototype.update, observed = [];
    GroupMetrics.prototype.update = function (session, now, photon) {
      const result = update.call(this, session, now, photon);
      observed.push({ at: now, age: result.groups[0]?.age }); return result;
    };
    const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    try {
      const deadline = performance.now() + 3000;
      do {
        await frame();
        if (performance.now() > deadline) throw new Error("Could not place the pulse within a graph bucket");
      } while (performance.now() % 100 >= 20);
      const fixture = window.dashboardFixture;
      fixture.ages[0] = 600; fixture.publish();
      await frame();
      fixture.ages[0] = 20; fixture.publish();
      await frame();
      const high = observed.find(sample => sample.age > 500);
      const recovered = high && observed.find(sample => sample.at > high.at && sample.age < 100);
      return { high, recovered };
    } finally { GroupMetrics.prototype.update = update; window.dashboardFixture.ages[0] = 20; }
  });
  assert.ok(pulse.high && pulse.recovered, "A one-frame source-age spike and recovery reached the dashboard");
  assert.equal(Math.floor(pulse.high.at / 100), Math.floor(pulse.recovered.at / 100), "Spike and recovery share a graph bucket");
  await page.waitForTimeout(120);
  assert.ok(parseFloat(await page.locator("#sample-age").textContent()) < 100, "A brief group spike does not replace the headline median");
  assert.ok(await page.locator("#age-chart path").first().evaluate(el => /[ML][^,]+,4\.00/.test(el.getAttribute("d"))), "Raw age trace retains the spike");
  await page.evaluate(() => { window.dashboardFixture.ages[0] = 20; window.dashboardFixture.paused = true; });
  await page.waitForFunction(() => document.querySelector('#age-chart-tooltip [data-group="1"] .group-median').textContent === "—");
  const available = await page.evaluate(() => ({
    headline: document.querySelector("#sample-age").textContent,
    known: document.querySelector('#age-chart-tooltip [data-group="0"] .group-median').textContent,
    missing: document.querySelector('#age-chart-tooltip [data-group="1"] .group-note').textContent,
  }));
  assert.equal(available.headline, available.known, "One missing group does not hide the known group median");
  assert.equal(available.missing, "Unavailable");
  assert.ok((await page.locator("#age-chart path").first().getAttribute("d")).includes("L"), "Known group trace remains visible");
  await page.locator("#age-metric .metric-label").hover();
  assert.equal(await page.locator("#age-chart-tooltip").isVisible(), true);
  assert.match(await page.locator('#age-chart-tooltip [data-group="0"] .group-label').textContent(), /Inputs/);
  await page.locator("#age-chart-tooltip").hover();
  assert.equal(await page.locator("#age-chart-tooltip").isVisible(), true);
  await page.screenshot({ path: fileURLToPath(new URL("../../.artifacts/viewer/dashboard/available-median-tooltip.png", import.meta.url)) });
  await page.evaluate(() => { window.dashboardFixture.ages[0] = -60; });
  await page.waitForFunction(() => parseFloat(document.querySelector("#sample-age").textContent) < 0);
  await page.evaluate(() => { window.dashboardFixture.paused = false; window.dashboardFixture.ages[0] = 20; });
  await page.waitForFunction(() => document.querySelector("#sample-age").textContent.endsWith(" ms"));

  const screenshots = fileURLToPath(new URL("../../.artifacts/viewer/dashboard/", import.meta.url));
  await mkdir(screenshots, { recursive: true });
  for (const width of [1440, 820, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No horizontal overflow at ${width}`);
    const controls = await page.locator("header .brand, header #choose-operator, header #status, header #connect").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, right: r.right, y: r.y, bottom: r.bottom }; }));
    assert.ok(controls.every(r => r.x >= 0 && r.right <= width), `Header controls fit at ${width}`);
    const header = await page.locator("header").boundingBox(), metrics = await page.locator(".metrics").boundingBox();
    assert.ok(metrics.y - (header.y + header.height) < 75, "No unused hero spacing");
    for (const metric of await page.locator(".metrics viewer-metric").all()) {
      await page.mouse.move(0, 0); await page.locator("header #connect").focus();
      await metric.locator(".metric-label").hover();
      const tooltip = metric.locator('[role="tooltip"]');
      assert.equal(await tooltip.isVisible(), true, "Every dashboard label opens its tooltip");
      const bounds = await tooltip.boundingBox();
      assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, `Tooltip fits ${width}px: ${await metric.getAttribute("id")} at ${JSON.stringify(bounds)}`);
      await tooltip.hover(); assert.equal(await tooltip.isVisible(), true, "Pointer can enter every tooltip");
      await page.mouse.move(0, 0); await metric.focus();
      assert.equal(await tooltip.isVisible(), true, "Every dashboard tile supports keyboard focus");
      await page.keyboard.press("Escape"); assert.equal(await tooltip.isVisible(), false);
    }
    await page.locator("header #connect").focus(); await page.mouse.move(0, 0);
    await page.screenshot({ path: `${screenshots}${width}.png` });
  }
  await page.locator("header #connect").click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected");
  await page.evaluate(() => window.restoreDashboard());
  await page.route("**/api/offer", route => route.fulfill({ status: 503, body: "Test unavailable" }));
  await page.route("**/api/health", route => route.fulfill({ json: { source: "test" } }));
  await page.locator("header #connect").click();
  await page.locator("#error").waitFor({ state: "visible" });
  assert.equal(await page.locator("#status").innerText(), "Disconnected");
  assert.equal(await page.locator("#workspace-title").innerText(), "Operator disconnected");
  assert.equal(await page.locator("subscription-editor").count(), 0);
  assert.match(await page.locator("#error").innerText(), /127\.0\.0\.1:1/);
  assert.equal(await page.locator("#connect").innerText(), "Retry");
  const address = "http://192.168.1.42:8082";
  await page.getByRole("button", { name: "Choose operator" }).click();
  await page.getByLabel("Operator address").fill(address + "/");
  await page.locator("#error").waitFor({ state: "hidden" });
  const requests = ["health", "offer"].map(route => page.waitForRequest(r => r.url().endsWith("/api/" + route)));
  await page.getByLabel("Operator address").press("Enter");
  for (const request of await Promise.all(requests)) assert.equal(await request.headerValue("X-Operator-Address"), address);
  await page.waitForFunction(() => !document.querySelector("#error").hidden);
  assert.ok((await page.locator("#error").innerText()).includes(address));
  assert.equal(await page.locator("#target").inputValue(), address);
  await page.route("**/api/health", route => route.fulfill({ headers: { "X-Operator-Response": "1" }, json: { tracking: false } }));
  await page.reload();
  await page.waitForFunction(value => document.querySelector("#target").value === value, address);
  await dialog.getByRole("button", { name: new RegExp(address + ".*HTTP reachable · input unavailable") }).waitFor();
  const discovered = { name: "Lab operator", address: "http://192.0.2.2:8123" };
  await page.evaluate(endpoint => window.testDiscovery.snapshot([endpoint]), discovered);
  assert.equal(await dialog.getByLabel("Operator address").inputValue(), address);
  await dialog.getByRole("button", { name: /Lab operator/ }).click();
  assert.equal(await dialog.getByLabel("Operator address").inputValue(), discovered.address);
  await page.evaluate(() => window.testDiscovery.snapshot([]));
  assert.equal(await dialog.getByRole("button", { name: /Lab operator/ }).count(), 0);
  assert.equal(await dialog.getByLabel("Operator address").inputValue(), discovered.address);
  await dialog.getByRole("button", { name: /Use default/ }).click();
  assert.equal(await dialog.getByLabel("Operator address").inputValue(), "http://127.0.0.1:1");
  assert.deepEqual(errors, []);
  console.log("PASS: compact header/footer cleanup, keyboard/connection/error controls, 0 ms default, distinct sample freshness/effect age endpoints and photon delay, grouped age/arrival headlines and raw traces, missing-data behavior, 1440/800/390/320 px layouts");
} finally {
  try { await browser?.close(); } finally {
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGTERM");
    await Promise.race([exited, pause(3000)]);
    if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    await exited;
  }
}
