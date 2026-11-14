import assert from "node:assert/strict";

export async function checkTrackingColors(page, output) {
  await page.evaluate(async () => {
    const { SpatialView } = await import("/src/spatial.ts");
    const update = SpatialView.prototype.update;
    await new Promise(resolve => {
      SpatialView.prototype.update = function (...args) {
        window.trackingScene = this;
        SpatialView.prototype.update = update;
        update.apply(this, args); resolve();
      };
    });
  });
  const result = await page.evaluate(async () => {
    const Color = window.trackingScene.bodyPoints.material.color.constructor;
    const view = window.trackingScene, previous = view.latest;
    const colors = object => Array.from({ length: object.geometry.drawRange.count }, (_, i) => new Color().fromBufferAttribute(object.geometry.getAttribute("color"), i).getHexString());
    const sample = { poses: [{ position: [0, 1.5, 0], orientation: [0, 0, 0, 1], flags: 3, active: true }] };
    const body = { active: true, poses: [true, false, undefined, false, true].map((tracked, i) => ({ position: [i * .1, 1, 0], orientation: [0, 0, 0, 1], flags: i === 3 ? 1 : i === 4 ? 2 : 3, active: true, tracked })) };
    const skeleton = { joints: body.poses.map((_, id) => ({ id, parent: id ? id - 1 : -1 })) };
    const materials = () => {
      const result = [];
      view.poses.get("head").group.traverse(object => {
        for (const m of [].concat(object.material ?? [])) if (m.color) result.push([m.color.getHexString(), m.vertexColors]);
      });
      return result;
    };
    const apply = (late, frame = body, hierarchy = skeleton) => { view.update({ poses: sample.poses.map(p => ({ ...p })) }, ["head"], late, frame, hierarchy); view.renderFrame(); };
    try {
      apply(false);
      const normal = { points: colors(view.bodyPoints), lines: colors(view.joints), materials: materials() };
      apply(true);
      const late = { points: colors(view.bodyPoints), lines: colors(view.joints), materials: materials() };
      apply(false);
      const recovered = { points: colors(view.bodyPoints), lines: colors(view.joints), materials: materials() };
      sample.poses[0].flags = 2; apply(false);
      const orientationInvalid = { visible: view.poses.get("head").group.visible, shape: view.poses.get("head").shape.visible };
      sample.poses[0].flags = 1; apply(true);
      const positionInvalid = view.poses.get("head").group.visible;
      const large = { active: true, poses: Array.from({ length: 120 }, (_, i) => ({ ...body.poses[0], position: [i * .01, 1, 0] })) };
      apply(true, large, { joints: large.poses.map((_, id) => ({ id, parent: id ? id - 1 : -1 })) });
      return { normal, late, recovered, orientationInvalid, positionInvalid, large: { points: colors(view.bodyPoints), lines: colors(view.joints) } };
    } finally { view.update(...previous); view.renderFrame(); }
  });
  assert.deepEqual(result.normal.points, ["286b4c", "c87520", "78847d", "286b4c"], "Invalid positions disappear; orientation-only invalidity preserves the position marker");
  assert.deepEqual(result.normal.lines, Array(4).fill("c87520"), "A bone touching an untracked joint is orange; invalid endpoints remove the bone");
  assert.deepEqual(result.late.points, Array(4).fill("c44235"));
  assert.deepEqual(result.late.lines, Array(4).fill("c44235"));
  assert.ok(result.late.materials.length > 2 && result.late.materials.every(([color, vertexColors]) => color === "c44235" && !vertexColors));
  assert.deepEqual(result.recovered, result.normal, "Recovery restores joint colors and original model/axis materials");
  assert.deepEqual(result.orientationInvalid, { visible: true, shape: false });
  assert.equal(result.positionInvalid, false);
  assert.deepEqual(result.large.points, Array(120).fill("c44235"));
  assert.deepEqual(result.large.lines, Array(238).fill("c44235"));

  await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const original = Session.prototype.tracking;
    window.restoreTrackingColors = () => { Session.prototype.tracking = original; };
    Session.prototype.tracking = function (...args) {
      const packet = original.apply(this, args);
      if (packet) this.active.get(packet.id).request.samples.forEach((selection, i) => {
        const descriptor = this.capabilities.descriptors[selection.descriptor];
        if ([14, 15].includes(descriptor.kind) && /^\/body\/FB\/(\d+)\//.test(descriptor.id) && Number(descriptor.id.split("/")[3]) >= 35) packet.values[i] = false;
      });
      return packet;
    };
  });
  try {
    await page.waitForFunction(() => window.trackingScene.latest[3]?.poses.some(p => p.tracked === false));
    await page.locator("#poses").screenshot({ path: output + "tracking-colors.png" });
  } finally { await page.evaluate(() => { window.restoreTrackingColors(); delete window.restoreTrackingColors; }); }
  await page.waitForFunction(() => window.trackingScene.latest[3]?.poses.every(p => p.tracked === true));
}
