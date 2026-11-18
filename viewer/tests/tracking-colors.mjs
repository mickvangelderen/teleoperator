import assert from "node:assert/strict";

export async function checkTrackingColors(page, output) {
  await page.evaluate(async () => {
    const spatialUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/spatial.ts")?.name ?? "/src/spatial.ts";
    const { SpatialView } = await import(spatialUrl);
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
    const body = { active: true, poses: [true, false, undefined, false, true].map((tracked, i) => ({ position: [i * .1, 1, 0], orientation: [0, 0, 0, 1], flags: i === 3 ? 1 : i === 4 ? 2 : 3, active: true, tracked })) };
    const skeleton = { joints: body.poses.map((_, id) => ({ id, parent: id ? id - 1 : -1 })) };
    const apply = (late, frame = body, hierarchy = skeleton) => { view.update(null, [], late, frame, hierarchy); view.renderFrame(); };
    try {
      apply(false);
      const normal = { points: colors(view.bodyPoints), lines: colors(view.joints) };
      apply(true);
      const late = { points: colors(view.bodyPoints), lines: colors(view.joints) };
      apply(false);
      const recovered = { points: colors(view.bodyPoints), lines: colors(view.joints) };
      const large = { active: true, poses: Array.from({ length: 120 }, (_, i) => ({ ...body.poses[0], position: [i * .01, 1, 0] })) };
      apply(true, large, { joints: large.poses.map((_, id) => ({ id, parent: id ? id - 1 : -1 })) });
      return { normal, late, recovered, large: { points: colors(view.bodyPoints), lines: colors(view.joints) } };
    } finally { view.update(...previous); view.renderFrame(); }
  });
  assert.deepEqual(result.normal.points, ["286b4c", "c87520", "78847d", "286b4c"], "Invalid positions disappear; orientation-only invalidity preserves the position marker");
  assert.deepEqual(result.normal.lines, Array(4).fill("c87520"), "A bone touching an untracked joint is orange; invalid endpoints remove the bone");
  assert.deepEqual(result.late.points, Array(4).fill("c44235"));
  assert.deepEqual(result.late.lines, Array(4).fill("c44235"));
  assert.deepEqual(result.recovered, result.normal, "Recovery restores joint colors");
  assert.deepEqual(result.large.points, Array(120).fill("c44235"));
  assert.deepEqual(result.large.lines, Array(238).fill("c44235"));

  await checkStandalonePoses(page);

  await page.evaluate(async () => {
    const sessionUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/session.ts")?.name ?? "/src/session.ts";
    const { Session } = await import(sessionUrl);
    const original = Session.prototype.tracking;
    window.restoreTrackingColors = () => { Session.prototype.tracking = original; };
    Session.prototype.tracking = function (...args) {
      const packet = original.apply(this, args);
      if (packet) this.active.get(packet.id).request.bundles[0].forEach((selection, i) => {
        const descriptor = this.capabilities.descriptors[selection.descriptor];
        if ([14, 15].includes(descriptor.kind) && /^\/body\/FB\/(\d+)\//.test(descriptor.id) && Number(descriptor.id.split("/")[3]) >= 35) packet.bundles[0][i] = false;
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

async function checkStandalonePoses(page) {
  const states = await page.evaluate(async () => {
    const { Session } = await import("/src/session.ts");
    const { timing, NON_MAX } = await import("/src/protocol.ts");
    const { spatialFrames } = await import("/src/tracking-view.ts");
    const name = "/phone/input/grip/pose", view = window.trackingScene, previous = view.latest;
    const descriptors = [
      { id: name, kind: 10, formats: [10], spaces: [2, 3], position_valid_sample: 1, orientation_valid_sample: 2, position_tracked_sample: 3, orientation_tracked_sample: 4 },
      ...[12, 13, 14, 15].map(kind => ({ id: name + "/" + kind, kind, formats: [1], spaces: [] })),
    ].map(d => ({ ...d, group: 0, name: d.id, description: "" }));
    const s = new Session();
    s.receive({ tag: 2, version: 1 });
    s.receive({ tag: 3, capabilities: { descriptors, groups: [60], skeletons: [] } });
    const subscribe = space => {
      s.request({ id: 1, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: null,
        bundles: [descriptors.map((d, descriptor) => ({ descriptor, format: d.formats[0], space: descriptor === 0 ? space : 0 }))] });
      s.receive({ tag: 5, id: 1 });
    };
    let now = 100;
    const send = (pose, quality) => {
      const bytes = new DataView(new ArrayBuffer(49));
      bytes.setUint32(0, 1, true); bytes.setBigUint64(4, BigInt(++now), true); bytes.setBigUint64(12, NON_MAX, true);
      bytes.setUint8(20, quality); // Position valid, orientation valid, position tracked, orientation tracked.
      pose.forEach((v, i) => bytes.setFloat32(21 + i * 4, v, true));
      if (!s.tracking(new Uint8Array(bytes.buffer), now, 1)) throw Error("Fixture packet rejected");
    };
    const draw = (late = []) => {
      const frame = spatialFrames(s, now, false, new Set(late));
      view.update(frame.poses, frame.sources, late.length > 0); view.renderFrame();
      const object = view.poses.get(name);
      return object?.group.visible ? [object.marker.material.color.getHexString(),
        object.shape.children[0].material.color.getHexString(), object.group.position.toArray(), object.group.quaternion.toArray()] : null;
    };
    const a = [1, 2, 3, 0, 0, 0, 1], b = [4, 5, 6, 0, 1, 0, 0];
    try {
      subscribe(2);
      const waiting = draw();
      send(a, 15);
      const healthy = draw([999]); // Another stream's late status must not color the phone.
      send(b, 10);
      const rotation = draw();
      send(b, 1);
      const position = draw();
      send(a, 0);
      const invalid = draw();
      send(a, 15);
      const late = draw([s.active.get(1).generation]);
      now += 600;
      const stale = draw();
      send(b, 15);
      const recovered = draw();
      s.stop(1); s.receive({ tag: 8, id: 1, reason: "Source lost" });
      const ended = draw();
      subscribe(3); send(b, 0);
      const replaced = draw();
      s.retire();
      return { waiting, healthy, rotation, position, invalid, late, stale, recovered, ended, replaced, retired: draw() };
    } finally { view.update(...previous); view.renderFrame(); }
  });
  const red = "c44235", green = "286b4c", orange = "c87520";
  const origin = [0, 0, 0], a = [1, 2, 3], b = [4, 5, 6], neutral = [0, 0, 0, 1], rotated = [0, 1, 0, 0];
  assert.deepEqual(states, {
    waiting: [red, red, origin, neutral], healthy: [green, green, a, neutral],
    rotation: [red, green, a, rotated], position: [orange, red, b, rotated], invalid: [red, red, b, rotated],
    late: [red, red, a, neutral], stale: [red, red, a, neutral], recovered: [green, green, b, rotated],
    ended: null, replaced: [red, red, origin, neutral], retired: null,
  });
}
