import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Run against Vite dev and the explicit --synthetic-tracking server.
const url = process.env.VIEWER_URL || "http://127.0.0.1:5174";
const output = new URL("../../.artifacts/tracking/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
const errors = [];
async function client(rate) {
  const page = await browser.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/__tracking_test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Tracking transport test</title>" }));
  await page.goto(url + "/__tracking_test");
  await page.evaluate(async rate => {
    const { Connection } = await import("/src/connection.ts");
    window.client = new Connection(() => {});
    await window.client.connect();
    window.client.setConsumerRate(rate);
  }, rate);
  await page.waitForFunction(() => window.client.state.streams.length === 3 && window.client.state.streams.every(s => s.sample !== null) || window.client.state.status === "Error");
  assert.equal(await page.evaluate(() => window.client.state.status), "Connected");
  assert.equal(await page.evaluate(() => window.client.state.source), "synthetic");
  return page;
}
async function snapshot(page, type = "pose") {
  return page.evaluate(type => {
    const live = window.client.state.streams.find(s => s.descriptor.type === type);
    const s = live.statistics, stream = live.descriptor;
    return { at: performance.now(), stream: String(stream.streamId), subscription: String(stream.subscriptionId), received: Number(s.messages.unique), missing: Number(s.messages.missing), reordered: Number(s.messages.reordered), duplicates: Number(s.messages.duplicates), sampleGaps: Number(s.samples.missing), coalesced: s.consumer.coalesced, consumed: s.consumer.consumed, discarded: s.discarded, ageMs: s.age, pending: s.consumer.pending ? 1 : 0 };
  }, type);
}
function delta(before, after) {
  const elapsed = (after.at - before.at) / 1000;
  return { seconds: elapsed, messages: after.received - before.received, messagesPerSecond: (after.received - before.received) / elapsed, missing: after.missing - before.missing, coalesced: after.coalesced - before.coalesced, consumed: after.consumed - before.consumed, ageMs: after.ageMs, discarded: after.discarded - before.discarded };
}
try {
  const fast = await client(60), slow = await client(5);
  const start = await Promise.all([snapshot(fast), snapshot(slow)]);
  const otherStart = await Promise.all([snapshot(fast, "controller"), snapshot(fast, "body"), snapshot(slow, "body")]);
  assert.equal(start[0].subscription, start[1].subscription, "Identical requests share acquisition");
  await new Promise(r => setTimeout(r, 10_000));
  const end = await Promise.all([snapshot(fast), snapshot(slow)]);
  const otherEnd = await Promise.all([snapshot(fast, "controller"), snapshot(fast, "body"), snapshot(slow, "body")]);
  const simultaneous = { controller: delta(otherStart[0], otherEnd[0]), bodyFast: delta(otherStart[1], otherEnd[1]), bodySlow: delta(otherStart[2], otherEnd[2]) };
  for (const result of Object.values(simultaneous)) { assert.ok(result.messagesPerSecond > 80); assert.equal(result.discarded, 0); }
  const baseline = { fast: delta(start[0], end[0]), slow: delta(start[1], end[1]) };
  assert.ok(baseline.fast.messagesPerSecond > 80 && baseline.slow.messagesPerSecond > 80);
  assert.ok(baseline.slow.coalesced > 800 && baseline.slow.consumed <= 55);
  assert.equal(baseline.fast.discarded, 0); assert.equal(baseline.slow.discarded, 0);

  const blockedStart = await Promise.all([snapshot(fast), snapshot(slow)]);
  // Browser SCTP still ACKs while JS is blocked: this exercises callback backlog, not network loss.
  await slow.evaluate(() => { const until = performance.now() + 2000; while (performance.now() < until) {} });
  await new Promise(r => setTimeout(r, 1000));
  const blockedEnd = await Promise.all([snapshot(fast), snapshot(slow)]);
  const blocked = { fast: delta(blockedStart[0], blockedEnd[0]), slow: delta(blockedStart[1], blockedEnd[1]) };
  assert.ok(blocked.fast.messagesPerSecond > 80);
  assert.ok(blockedEnd[1].pending <= 1 && blockedEnd[1].ageMs < 500);

  await slow.evaluate(() => window.client.setPublication(10, 8));
  await slow.waitForFunction(() => window.client.state.streams.find(s => s.descriptor.type === "pose").descriptor.rate === 10);
  const limitedStart = await snapshot(slow);
  await new Promise(r => setTimeout(r, 3000));
  const limitedEnd = await snapshot(slow);
  const limited = delta(limitedStart, limitedEnd);
  assert.ok(limited.messagesPerSecond > 8 && limited.messagesPerSecond < 12);
  assert.equal(limitedStart.subscription, limitedEnd.subscription, "Publication changes retain acquisition identity");

  await slow.evaluate(() => window.client.setPublication(1, 1, "controller"));
  await slow.waitForFunction(() => window.client.state.streams.find(s => s.descriptor.type === "controller")?.descriptor.rate === 1);
  const counterSnapshot = page => page.evaluate(() => {
    const s = window.client.state.streams.find(s => s.descriptor.type === "controller");
    const input = s.sample.inputs.find(i => i.type === 0);
    return { presses: Number(input.presses), releases: Number(input.releases), messages: Number(s.statistics.messages.unique), subscription: String(s.descriptor.subscriptionId) };
  });
  const counterStart = await counterSnapshot(slow);
  await new Promise(r => setTimeout(r, 3200));
  const counterEnd = await counterSnapshot(slow);
  assert.equal(counterStart.subscription, counterEnd.subscription);
  assert.ok(counterEnd.presses - counterStart.presses >= 2 && counterEnd.releases - counterStart.releases >= 2);
  assert.ok(counterEnd.messages - counterStart.messages <= 5);

  await slow.evaluate(() => window.client.setPublication(30, 8, "body"));
  await slow.waitForFunction(() => window.client.state.streams.find(s => s.descriptor.type === "body")?.descriptor.history === 8);
  const bodyHistoryStart = await snapshot(slow, "body");
  await new Promise(r => setTimeout(r, 2000));
  const bodyHistoryEnd = await snapshot(slow, "body"), bodyHistory = delta(bodyHistoryStart, bodyHistoryEnd);
  assert.ok(bodyHistory.messagesPerSecond > 25 && bodyHistory.messagesPerSecond < 35);
  assert.equal(bodyHistory.discarded, 0);

  // Deterministic receiver injection verifies metrics; this is explicitly not measured network loss.
  await fast.evaluate(async () => {
    const { decode } = await import("/src/protocol.ts");
    const streamId = window.client.state.streams.find(s => s.descriptor.type === "pose").descriptor.streamId;
    const channel = window.client.tracking, receive = channel.onmessage;
    window.injected = 0; let n = 0;
    channel.onmessage = event => {
      const message = decode(new Uint8Array(event.data), "tracking");
      if (message.kind === "Tracking" && message.streamId === streamId && ++n % 10 === 0) { window.injected++; return; }
      receive(event);
    };
  });
  const injectedStart = await snapshot(fast);
  await new Promise(r => setTimeout(r, 3000));
  const injectedEnd = await snapshot(fast);
  const injected = await fast.evaluate(() => window.injected);
  assert.ok(injectedEnd.missing - injectedStart.missing >= injected - 1);

  const ui = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  ui.on("pageerror", error => errors.push(error.message));
  await ui.goto(url); await ui.getByRole("button", { name: "Connect" }).click();
  await ui.waitForFunction(() => document.querySelector("#poses").dataset.poseCount === "5" && document.querySelector("#poses").dataset.bodyJoints === "70" && document.querySelector("#poses").dataset.assets === "ready");
  await ui.waitForFunction(() => parseFloat(document.querySelector("#tracking-rate").textContent) > 50);
  await ui.screenshot({ path: new URL("viewer.png", output).pathname, fullPage: true });
  await ui.screenshot({ path: new URL("overview.png", output).pathname });
  await ui.locator(".tracking-stats").screenshot({ path: new URL("statistics.png", output).pathname });
  await ui.setViewportSize({ width: 390, height: 844 });
  assert.ok(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await ui.screenshot({ path: new URL("mobile.png", output).pathname, fullPage: true });
  await fast.evaluate(() => window.client.close()); await slow.evaluate(() => window.client.close());
  await ui.getByRole("button", { name: "Disconnect" }).click();
  const sender = await ui.evaluate(async () => (await fetch("/api/stats")).json());
  const report = { source: "synthetic", transport: "real local WebRTC, unordered, maxRetransmits=0", measuredAt: new Date().toISOString(), baseline, simultaneous, blocked, limited, bodyHistory, controllerCountersAt1Hz: { before: counterStart, after: counterEnd }, receiverInjection: { droppedByTest: injected, additionalMissing: injectedEnd.missing - injectedStart.missing }, sender };
  assert.deepEqual(errors, []);
  await writeFile(new URL("measurements.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
