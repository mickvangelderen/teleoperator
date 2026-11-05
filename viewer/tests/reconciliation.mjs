import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_EXECUTABLE;
assert.ok(executablePath, "Set CHROMIUM_EXECUTABLE to Chrome/Chromium");
const browser = await chromium.launch({ executablePath, headless: true });
const output = new URL("../../.artifacts/reconciliation/", import.meta.url);
await mkdir(output, { recursive: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    window.frameGate = { paused: false, pending: [], active: false };
    const run = (callback, now) => {
      window.frameGate.active = true;
      try { callback(now); } finally { window.frameGate.active = false; }
    };
    window.requestAnimationFrame = callback => request(now => {
      if (window.frameGate.paused) window.frameGate.pending.push(callback);
      else run(callback, now);
    });
    window.resumeFrames = () => {
      window.frameGate.paused = false;
      for (const callback of window.frameGate.pending.splice(0)) request(now => run(callback, now));
    };
  });
  await page.goto(process.env.VIEWER_URL || "http://127.0.0.1:5173");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  await page.waitForFunction(() => document.querySelector("#transfer-received [data-stat]").textContent === "0.00");
  await page.evaluate(() => {
    window.audit = { replacements: 0, unchangedWrites: 0, outsideFrame: 0 };
    const watched = node => (node.nodeType === 1 ? node : node.parentElement)?.closest("#performance, #pose-values, #input-values, #status, #session-id, #payload, #graphics-status");
    for (const [prototype, property] of [[Node.prototype, "textContent"], [CharacterData.prototype, "data"]]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      Object.defineProperty(prototype, property, { ...descriptor, set(value) {
        if (watched(this)) {
          if (!window.frameGate.active) window.audit.outsideFrame++;
          if (descriptor.get.call(this) === value) window.audit.unchangedWrites++;
        }
        descriptor.set.call(this, value);
      } });
    }
    window.observer = new MutationObserver(records => {
      for (const record of records) window.audit.replacements += record.addedNodes.length + record.removedNodes.length;
    });
    for (const selector of ["#profile-results", "#pose-values", "#input-values"])
      window.observer.observe(document.querySelector(selector), { subtree: true, childList: true });
  });
  await page.waitForTimeout(1200);
  const idle = await page.evaluate(() => ({ ...window.audit }));
  assert.deepEqual(idle, { replacements: 0, unchangedWrites: 0, outsideFrame: 0 });

  await page.getByRole("button", { name: /^Connect/ }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Connected" && document.querySelectorAll("#input-values > div").length === 27);
  await page.evaluate(() => {
    window.rows = [...document.querySelectorAll("#pose-values > div, #input-values > div")];
    window.audit.replacements = 0;
  });
  await page.waitForTimeout(1200);
  const connected = await page.evaluate(() => ({ ...window.audit, retainedRows: window.rows.every((row, i) => row === document.querySelectorAll("#pose-values > div, #input-values > div")[i]) }));
  assert.deepEqual(connected, { replacements: 0, unchangedWrites: 0, outsideFrame: 0, retainedRows: true });

  await page.getByLabel("Viewer consumer").selectOption("5");
  await page.evaluate(() => { window.frameGate.paused = true; });
  await page.waitForFunction(() => window.frameGate.pending.length > 0,undefined, { polling: 20 });
  const before = await page.locator("#received").textContent();
  const arrivals = () => page.evaluate(async () => {
    const module = performance.getEntriesByType("resource").findLast(entry => new URL(entry.name).pathname === "/src/performance.ts");
    const { profiler } = await import(module.name);
    return profiler.snapshot().metrics.find(metric => metric.key === "poseArrival").samples.length;
  });
  const arrivalsBefore = await arrivals();
  await page.waitForTimeout(1200);
  assert.equal(await page.locator("#received").textContent(), before, "Packets do not reconcile the DOM outside a frame");
  assert.ok(await arrivals() > arrivalsBefore + 20, "Receive measurements continue while animation frames are paused");
  await page.evaluate(() => window.resumeFrames());
  await page.waitForFunction(before => document.querySelector("#received").textContent !== before, before);

  await page.getByRole("button", { name: /Inspect ServerHello/ }).click();
  await page.waitForFunction(() => document.querySelector("#payload").textContent.includes('"selectedVersion": 2'));
  await page.getByRole("button", { name: "Disconnect" }).click();
  await page.waitForFunction(() => document.querySelector("#status").textContent === "Disconnected" && !document.querySelector("#input-values").children.length && !document.querySelector("#pose-values").children.length);
  const final = await page.evaluate(() => ({ ...window.audit }));
  assert.equal(final.outsideFrame, 0);
  assert.equal(final.unchangedWrites, 0);
  assert.deepEqual(errors, []);
  await writeFile(new URL("result.json", output), JSON.stringify({ idle, connected, final, errors }, null, 2));
  console.log("PASS: frame-bound reconciliation, uninterrupted reception, stable rows/text nodes, unchanged-value suppression, inspector and disconnect");
} finally { await browser.close(); }
