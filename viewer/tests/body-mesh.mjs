import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

// Run against an explicitly chosen private viewer and synthetic server.
const url = process.env.VIEWER_URL, executablePath = process.env.CHROMIUM_EXECUTABLE;
assert.ok(url && executablePath, "Set VIEWER_URL and CHROMIUM_EXECUTABLE");
const output = new URL("../../.artifacts/body-mesh/", import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const health = await (await page.request.get(new URL("/api/health", url).href)).json();
  assert.equal(health.source, "synthetic", "Never connect this test to hardware");
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#poses").dataset.assets === "ready");
  await page.evaluate(async () => {
    const spatialUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/spatial.ts")?.name ?? "/src/spatial.ts";
    const { SpatialView } = await import(spatialUrl);
    const update = SpatialView.prototype.update;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { SpatialView.prototype.update = update; reject(new Error("SpatialView capture timeout")); }, 10000);
      SpatialView.prototype.update = function (...args) {
        window.meshView = this;
        SpatialView.prototype.update = update;
        update.apply(this, args); clearTimeout(timeout); resolve();
      };
    });
  });
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyMesh === "true");
  await page.locator("#view-angle").selectOption("front");
  await page.locator("#view-zoom").evaluate(input => { input.value = "1.5"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  const inspect = () => page.evaluate(() => {
    const v = window.meshView, meshes = [];
    v.body.root.traverse(o => { if (o.isSkinnedMesh && o.visible) meshes.push(o); });
    return { visible: v.body.root.visible, meshes: meshes.length,
      triangles: meshes.reduce((n, m) => n + (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3, 0),
      geometry: meshes.map(m => m.geometry.uuid), memory: v.renderer.info.memory,
      joints: v.surface.dataset.bodyJoints, lines: v.joints.geometry.drawRange.count,
      overlay: { points: v.bodyPoints.visible, lines: v.joints.visible },
      devices: [...v.poses].filter(([, o]) => o.group.visible).map(([name]) => name),
      rest: v.latest[5]?.skeleton.joints.map(j => j.rest.position),
    };
  });
  const live = await inspect();
  assert.ok(live.visible && live.meshes >= 3 && live.triangles > 25000, "Actual skinned surfaces must render");
  assert.equal(live.joints, "70");
  assert.ok(live.lines > 100);
  assert.deepEqual(live.overlay, { points: true, lines: true });
  await page.locator("#poses").screenshot({ path: new URL("live-mesh-overlay.png", output).pathname });
  await page.locator("#show-joints").uncheck();
  const meshOnly = await inspect();
  assert.deepEqual(meshOnly.overlay, { points: false, lines: false });
  assert.deepEqual(meshOnly.devices, live.devices, "Body overlay control preserves device models");
  assert.equal(meshOnly.visible, true);
  await page.locator("#poses").screenshot({ path: new URL("live-mesh-surface.png", output).pathname });
  await page.locator("#show-joints").check();
  await page.locator("#show-body-mesh").uncheck();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyMesh === "false");
  assert.equal((await inspect()).joints, "70", "Mesh toggle preserves joint markers");
  await page.locator("#poses").screenshot({ path: new URL("live-overlay-only.png", output).pathname });
  await page.locator("#show-body-mesh").check();
  await page.locator("#skeleton-view").selectOption("rest");
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyMesh === "true" && document.querySelector("#body-quality").textContent.includes("advertised rest poses"));
  const rest = await inspect();
  assert.deepEqual(rest.geometry, live.geometry, "Rest view reuses geometry");
  await page.locator("#poses").screenshot({ path: new URL("rest-mesh-overlay.png", output).pathname });
  await page.locator("#show-joints").uncheck();
  assert.deepEqual((await inspect()).overlay, { points: false, lines: false });
  await page.locator("#poses").screenshot({ path: new URL("rest-mesh-surface.png", output).pathname });
  await page.locator("#view-angle").selectOption("iso");
  await page.locator("#poses").screenshot({ path: new URL("rest-mesh-perspective.png", output).pathname });
  const captured = JSON.parse(await readFile(new URL("./fixtures/quest-body-rest.json", import.meta.url), "utf8"));
  await page.evaluate(skeleton => {
    const v = window.meshView, update = v.update, previous = v.latest;
    window.restoreMeshCapture = () => { v.update = update; v.update(...previous); v.reframe(); v.renderFrame(); };
    const sample = { active: true, poses: skeleton.joints.map(j => j.rest) };
    v.update(null, [], false, sample, skeleton, { sample, skeleton }); v.renderFrame();
    v.setView("iso", 1); v.renderFrame();
    v.update = () => {}; // Hold the archived frame just for its screenshot.
  }, captured);
  try {
    assert.equal((await inspect()).triangles, 25261);
    await page.locator("#poses").screenshot({ path: new URL("archived-quest-rest-mesh.png", output).pathname });
  } finally { await page.evaluate(() => { window.restoreMeshCapture(); delete window.restoreMeshCapture; }); }
  const invalid = await page.evaluate(() => {
    const v = window.meshView, prior = v.latest, args = [...prior];
    window.meshFrame = prior;
    try {
      args[5] = undefined; v.update(...args); v.renderFrame();
      const withoutRest = v.body.root.visible;
      args[5] = { ...prior[5], sample: { ...prior[5].sample, poses: prior[5].sample.poses.map(p => ({ ...p, flags: 0 })) } };
      v.update(...args); v.renderFrame(); const invalid = v.body.root.visible;
      args[5] = prior[5]; args[2] = true; v.update(...args); v.renderFrame();
      const colors = []; v.body.root.traverse(o => { if (o.isSkinnedMesh) colors.push(o.material.color.getHexString()); });
      return { withoutRest, invalid, lateColors: colors };
    } finally { v.update(...prior); v.renderFrame(); }
  });
  assert.equal(invalid.withoutRest, false);
  assert.equal(invalid.invalid, false);
  assert.ok(invalid.lateColors.every(c => c === "c44235"));
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyMesh === "false");
  await page.locator("#connect").click();
  await page.waitForFunction(() => document.querySelector("#poses").dataset.bodyMesh === "true");
  const reconnected = await inspect();
  assert.deepEqual(reconnected.geometry, live.geometry, "Reconnect reuses mesh resources");
  assert.deepEqual(reconnected.memory, rest.memory, "Reconnect does not leak GPU resources");
  await page.locator("#connect").click();
  const cleanup = await page.evaluate(() => {
    const v = window.meshView, rigs = new Set();
    v.body.root.traverse(o => { if (o.isSkinnedMesh) rigs.add(o.skeleton); });
    v.dispose();
    return { canvases: v.surface.querySelectorAll("canvas").length, texturesDisposed: [...rigs].every(r => r.boneTexture === null) };
  });
  assert.deepEqual(cleanup, { canvases: 0, texturesDisposed: true });
  const remount = await page.evaluate(async () => {
    const spatialUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/spatial.ts")?.name ?? "/src/spatial.ts";
    const { SpatialView } = await import(spatialUrl);
    const surface = document.createElement("div");
    surface.style.cssText = "width:600px;height:400px"; document.body.append(surface);
    const v = new SpatialView(surface, () => {});
    try {
      // Await the owned loader, without starting another animation loop.
      await new Promise((resolve, reject) => {
        const deadline = performance.now() + 10000;
        const check = () => surface.dataset.assets ? resolve() : performance.now() > deadline ? reject(new Error("Remount asset timeout")) : setTimeout(check, 10);
        check();
      });
      if (!v.body) throw new Error("Remount did not load body mesh");
      v.update(...window.meshFrame); v.renderFrame();
      return { assets: surface.dataset.assets, canvases: surface.querySelectorAll("canvas").length, visible: v.body.root.visible };
    } finally { v.dispose(); surface.remove(); }
  });
  assert.deepEqual(remount, { assets: "ready", canvases: 1, visible: true });
  assert.deepEqual(errors, []);
  const report = { live, meshOnly, rest, invalid, reconnected, cleanup, remount, archivedRest: captured.provenance, errors };
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ live: { meshes: live.meshes, triangles: live.triangles, joints: live.joints }, cleanup, errors }));
} finally { await browser.close(); }
