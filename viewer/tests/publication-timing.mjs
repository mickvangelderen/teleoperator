import assert from "node:assert/strict";

// Exercise the browser's actual Connection encoder with controlled timing evidence.
// No server-specific horizon or physical display timing is inferred by this check.
export async function checkPublicationTimingModel(page) {
  const results = await page.evaluate(async () => {
    const connectionUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/connection.ts")?.name ?? "/src/connection.ts";
    const { Connection } = await import(connectionUrl);
    const { timing } = await import("/src/protocol.ts");
    const realPeer = window.RTCPeerConnection;
    class Channel {
      readyState = "open"; bufferedAmount = 0; sent = [];
      send(bytes) { this.sent.push(bytes.slice()); }
    }
    class Peer {
      static latest;
      control = new Channel(); tracking = new Channel(); sctp = { maxMessageSize: 65536 };
      constructor() { Peer.latest = this; }
      createDataChannel(label) { return label === "reliable" ? this.control : this.tracking; }
      close() {}
    }
    const ns = ms => BigInt(Math.round(ms * 1e6)), mod = (a, b) => (a % b + b) % b;
    const results = [];
    window.RTCPeerConnection = Peer;
    try {
      for (const transit of [0.5, 12, 80]) for (const offset of [9_007_199_254_740_993n, -900_000_000n]) {
        const c = new Connection(() => {}), frames = [];
        c.session.receive({ tag: 2, version: 1 });
        c.session.receive({ tag: 3, capabilities: { skeletons: [], groups: [90], descriptors: [{ id: "pose", name: "pose", description: "", kind: 10, formats: [11], spaces: [2], group: 0 }] } });
        c.publish({ id: 1, group: 0, delivery: 1, ...timing(60), sequenceNumberFormat: null, bundles: [ [{ descriptor: 0, format: 11, space: 2 }]] }, true);
        c.session.receive({ tag: 5, id: 1 });
        let count = 0;
        for (let i = 0; i < 260; i++) {
          const now = 1000 + i * 1000 / 60;
          const photon = i < 90 ? 20 : i < 180 ? 60 : 0;
          const clockOffset = offset + ns(i < 180 ? 0 : 3);
          c.session.clockEstimate = () => ({ offset: clockOffset, delay: ns(2 * transit), at: now });
          c.frame(now, now, photon);
          const sent = Peer.latest.control.sent.filter(b => b[0] === 12);
          if (sent.length === count) continue;
          count = sent.length;
          const bytes = sent.at(-1), v = new DataView(bytes.buffer);
          const interval = v.getBigUint64(5, true), phase = v.getBigUint64(13, true), delay = v.getBigUint64(21, true);
          const earliest = ns(now + transit + 2) + clockOffset;
          const publication = earliest + mod(phase - earliest, interval);
          const target = publication + delay;
          const localRender = Number(target - clockOffset) / 1e6 - photon;
          const frameError = Math.abs((localRender - now) / (1000 / 60) - Math.round((localRender - now) / (1000 / 60))) * (1000 / 60);
          const age = c.session.sampleAge(target, localRender, photon);
          const signedAge = c.session.sampleAge(target + ns(3), localRender, photon);
          frames.push({ at: now, photon, interval: String(interval), delay: Number(delay) / 1e6, frameError, age, signedAge });
        }
        c.close();
        results.push({ transit, frames });
      }
      return results;
    } finally { window.RTCPeerConnection = realPeer; }
  });
  for (const result of results) {
    assert.ok(result.frames.length >= 3 && result.frames.length <= 5);
    assert.deepEqual([...new Set(result.frames.map(f => f.photon))], [20, 60, 0]);
    result.frames.forEach((frame, i) => {
      assert.equal(frame.interval, "16666667");
      assert.ok(Math.abs(frame.delay - result.transit - 3 - frame.photon) < 0.001);
      assert.ok(frame.frameError < 0.001, JSON.stringify(frame));
      assert.ok(Math.abs(frame.age) < 0.001);
      assert.ok(Math.abs(frame.signedAge + 3) < 0.001, "Future predictions retain a negative sample age");
      if (i) assert.ok(frame.at - result.frames[i - 1].at >= 1000);
    });
  }
}

export async function checkAutomaticPublicationTiming(page) {
  await checkPublicationTimingModel(page);
  await page.evaluate(async () => {
    const connectionUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/connection.ts")?.name ?? "/src/connection.ts";
    const { Connection } = await import(connectionUrl);
    const original = Connection.prototype.frame, send = RTCDataChannel.prototype.send;
    window.publicationTimingCheck = { updates: [], frameTimes: [], connection: undefined, restore() { Connection.prototype.frame = original; RTCDataChannel.prototype.send = send; } };
    Connection.prototype.frame = function (...args) {
      window.publicationTimingCheck.connection = this;
      window.publicationTimingCheck.frameTimes.push(args[0]);
      window.publicationTimingCheck.frameTimes = window.publicationTimingCheck.frameTimes.slice(-13);
      return original.apply(this, args);
    };
    RTCDataChannel.prototype.send = function (bytes) {
      if (bytes instanceof Uint8Array && bytes[0] === 12) {
        const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const times = window.publicationTimingCheck.frameTimes;
        const intervals = times.slice(1).map((t,i) => t-times[i]).sort((a,b) => a-b);
        const frameCadence = intervals[Math.floor(intervals.length/2)];
        window.publicationTimingCheck.updates.push({ frameCadence, id: v.getUint32(1, true), at: performance.now(), interval: String(v.getBigUint64(5, true)), delay: Number(v.getBigUint64(21, true)) / 1e6 });
      }
      return send.call(this, bytes);
    };
  });
  try {
    await page.waitForFunction(() => window.publicationTimingCheck.connection?.session.active.size > 0);
    assert.equal(await page.locator('subscription-editor [data-field="automatic"]').isChecked(), true);
    const initial = await page.evaluate(() => {
      const c = window.publicationTimingCheck.connection;
      return [...c.session.active.values()].find(s => s.request.group === 0).request.id;
    });
    await page.locator("#render-to-photon").fill("60");
    await page.waitForFunction(id => window.publicationTimingCheck.updates.some(u => u.id === id && u.delay >= 63 && u.delay < 90), initial);
    const automated = await page.evaluate(id => window.publicationTimingCheck.updates.findLast(u => u.id === id), initial);
    assert.equal(automated.id, initial, "Display delay changes use UpdateSchedule rather than replacement");
    assert.ok(Math.abs(Number(automated.interval) / 1e6 - automated.frameCadence) < 0.1, "Requested slots follow the observed browser cadence");
    await page.locator('subscription-editor [data-field="automatic"]').uncheck();
    await page.locator('.subscription-timing summary').click();
    await page.locator('subscription-editor [data-field="phase"]').fill("2");
    await page.locator('subscription-editor [data-field="predictionOffset"]').fill("5");
    await page.locator('subscription-editor [data-action="apply"]').click();
    await page.waitForFunction(id => window.publicationTimingCheck.updates.findLast(u => u.id === id)?.delay === 5, initial);
    const manualCount = await page.evaluate(id => window.publicationTimingCheck.updates.filter(u => u.id === id).length, initial);
    await page.locator("#render-to-photon").fill("0");
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(id => window.publicationTimingCheck.updates.filter(u => u.id === id).length, initial), manualCount, "Automatic updates respect manual control");
    await page.locator('subscription-editor [data-field="automatic"]').check();
    await page.locator('subscription-editor [data-action="apply"]').click();
    await page.waitForFunction(id => window.publicationTimingCheck.connection.isAutomatic(id), initial);
    await page.locator("#render-to-photon").fill("20");
    await page.waitForFunction(id => { const update = window.publicationTimingCheck.updates.findLast(u => u.id === id); return update?.delay >= 23 && update.delay < 50; }, initial);
    assert.equal(await page.evaluate(() => {
      const check = window.publicationTimingCheck;
      return check.updates.every(u => check.connection.isAutomatic(u.id));
    }), true, "Only groups opted into display alignment are retimed");
    const retargeted = await page.evaluate(async () => {
      const spatialUrl = performance.getEntriesByType("resource").find(e => new URL(e.name).pathname === "/src/spatial.ts")?.name ?? "/src/spatial.ts";
      const { SpatialView } = await import(spatialUrl);
      const session = window.publicationTimingCheck.connection.session;
      const sub = [...session.active.values()].find(s => s.request.group === 0);
      const index = sub.request.bundles[0].findIndex(s => session.capabilities.descriptors[s.descriptor].id === "/user/head/input/pose");
      const bundle = sub.bundles[0], packet = bundle.packet, tracking = Object.getOwnPropertyDescriptor(session, "tracking"), update = SpatialView.prototype.update;
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      let position;
      session.tracking = () => null;
      SpatialView.prototype.update = function (poses, sources, ...rest) {
        position = poses.poses[sources.indexOf("head")]?.position[0];
        return update.call(this, poses, sources, ...rest);
      };
      try {
        await frame();
        const before = position;
        const values = bundle.values.map((v, i) => i === index ? [v[0] + 0.25, ...v.slice(1)] : v);
        const nextPacket = { ...packet, predictedFor: (packet.predictedFor ?? packet.timestamp) + 16_666_667n, bundles: [values] };
        sub.packet = nextPacket;
        sub.bundles[0] = { ...bundle, packet: nextPacket, values, predictions: [], consumed: undefined }; sub.version++;
        await frame();
        return { before, after: position };
      } finally {
        sub.packet = packet; sub.bundles[0] = bundle; sub.version++;
        if (tracking) Object.defineProperty(session, "tracking", tracking); else delete session.tracking;
        SpatialView.prototype.update = update;
      }
    });
    assert.ok(Math.abs(retargeted.after - retargeted.before - 0.25) < 1e-6, "A new prediction of the same acquisition must update the rendered pose");
  } finally {
    await page.locator("#render-to-photon").fill("0");
    await page.evaluate(() => { window.publicationTimingCheck.restore(); delete window.publicationTimingCheck; });
  }
}
