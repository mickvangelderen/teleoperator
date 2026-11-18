import assert from "node:assert/strict";

export const selectGroup = async (page, group) => page.locator('subscription-editor [data-action="select"][data-group="' + group + '"]').first().click();
export const selectedEntry = page => page.evaluate(() => {
  const editor = document.querySelector("subscription-editor");
  const key = Number(editor.querySelector('[data-action="select"][aria-pressed="true"]').dataset.key);
  const e = editor.model.entries.find(e => e.key === key), active = editor.model.port.session.active.get(e.activeId);
  return { key, group: e.group, activeId: e.activeId, pendingId: e.pendingId, error: e.error, packets: active?.packets,
    delivery: active?.request.delivery, rate: active ? 1e9 / Number(active.request.interval) : undefined,
    draftRate: 1e9 / Number(e.draft.interval), bundleLengths: e.draft.bundles.map(b => b.bindings.length) };
});
export async function applySelected(page) {
  await page.locator('subscription-editor [data-action="apply"]').click();
  await page.waitForFunction(() => {
    const editor = document.querySelector("subscription-editor"), key = Number(editor.querySelector('[aria-pressed="true"]').dataset.key);
    const e = editor.model.entries.find(e => e.key === key);
    return e.pendingId === undefined;
  });
}
export async function addSample(page, bundle, id, companions = true) {
  const host = page.locator('[data-bundle-index="' + bundle + '"]');
  await host.locator('[data-action="catalogue"]').click();
  const catalogue = page.locator(".sample-catalogue");
  await catalogue.locator('[data-field="search"]').fill(id);
  const descriptor = await page.evaluate(id => document.querySelector("subscription-editor").model.capabilities.descriptors.findIndex(d => d.id === id), id);
  assert(descriptor >= 0, "Advertised sample " + id);
  await catalogue.locator('[data-field="companions"]').setChecked(companions);
  await catalogue.locator('[data-descriptor-index="' + descriptor + '"]').click();
  await catalogue.locator('[data-action="close-catalogue"]').click();
}
export async function createSubscription(page, group) {
  await page.locator('subscription-editor [data-action="new"]').click();
  await page.locator('[data-field="new-group"]').selectOption(String(group));
  await page.locator('[data-action="create"]').click();
  return selectedEntry(page);
}

export async function checkEditor(page, output) {
  const editor = page.locator("subscription-editor");
  const headId = "/user/head/input/pose", leftId = "/user/hand/left/input/aim/pose", rightId = "/user/hand/right/input/grip/pose";
  await selectGroup(page, 0);
  await page.locator('[data-descriptor="' + headId + '"]').scrollIntoViewIfNeeded();
  await page.waitForFunction(id => document.querySelector('[data-descriptor="' + id + '"]').dataset.available === "true", headId);
  const original = await selectedEntry(page);
  const head = editor.locator('[data-descriptor="' + headId + '"]');
  await head.locator('[data-field="format"]').selectOption("11");
  await page.waitForFunction(id => document.querySelector('[data-descriptor="' + id + '"] .binding-state').textContent === "Not applied", headId);
  assert.equal((await selectedEntry(page)).activeId, original.activeId);
  await editor.locator('[data-action="discard"]').click();
  await editor.locator('[data-field="automatic"]').uncheck();
  await editor.locator('[data-field="rate"]').fill("30");
  await applySelected(page);
  assert.equal((await selectedEntry(page)).activeId, original.activeId);
  assert.match(await editor.locator(".subscription-message").textContent(), /Timing sent.*no confirmation/);
  const before = await selectedEntry(page);
  await page.waitForTimeout(1100);
  const after = await selectedEntry(page);
  assert(after.packets - before.packets > 23 && after.packets - before.packets < 43, "Manual timing controls actual packet arrivals");
  await head.locator('[data-field="format"]').selectOption("11");
  await editor.locator('[data-field="delivery"]').selectOption("2");
  await applySelected(page);
  const replaced = await selectedEntry(page);
  assert.notEqual(replaced.activeId, original.activeId);
  assert.equal(await page.evaluate(id => document.querySelector("subscription-editor").model.port.session.active.has(id), original.activeId), false);

  // Real admission rejection: the synthetic server caps publication at 200 Hz.
  await editor.locator('[data-field="rate"]').fill("500");
  await editor.locator('[data-field="delivery"]').selectOption("1");
  await applySelected(page);
  await page.waitForFunction(() => !!document.querySelector("subscription-editor").model.entries.find(e => e.error));
  const rejected = await selectedEntry(page);
  assert.equal(rejected.activeId, replaced.activeId);
  assert.equal(rejected.delivery, 2); assert.equal(rejected.draftRate, 500);
  assert.match(rejected.error, /rate|interval/i);
  await page.waitForTimeout(150);
  assert((await selectedEntry(page)).packets > rejected.packets);
  await editor.locator('[data-action="discard"]').click();
  assert.equal((await selectedEntry(page)).error, undefined);

  await page.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    window.editorAcks = [];
    window.restoreEditorSend = () => { RTCDataChannel.prototype.send = send; };
    RTCDataChannel.prototype.send = function (data) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (bytes?.[0] === 13) window.editorAcks.push(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, true));
      return send.call(this, data);
    };
  });
  try {
    const added = await createSubscription(page, 0);
    await addSample(page, 0, headId);
    await addSample(page, 0, headId, false);
    const duplicate = editor.locator('[data-descriptor="' + headId + '"]').last();
    await duplicate.locator('[data-field="format"]').selectOption("11");
    const space = await duplicate.locator('[data-field="space"] option').last().getAttribute("value");
    await duplicate.locator('[data-field="space"]').selectOption(space);
    await editor.locator('[data-action="add-bundle"]').click();
    await addSample(page, 1, leftId);
    await editor.locator('[data-field="automatic"]').uncheck();
    await editor.locator('[data-field="rate"]').fill("20");
    await applySelected(page);
    const mixed = await selectedEntry(page);
    assert(mixed.activeId && mixed.activeId !== replaced.activeId);
    assert.equal(await page.evaluate(() => [...document.querySelector("subscription-editor").model.port.session.active.values()].filter(s => s.request.group === 0).length), 2);
    await page.waitForFunction(id => window.editorAcks.includes(id), mixed.activeId);
    await head.first().scrollIntoViewIfNeeded();
    await page.waitForFunction(id => {
      const editor = document.querySelector("subscription-editor"), sub = editor.model.port.session.active.get(id);
      const rows = [...editor.querySelectorAll('[data-descriptor="/user/head/input/pose"]')];
      if (!sub?.bundles[0] || rows.length !== 2) return false;
      const indices = sub.request.bundles[0].flatMap((s, i) => editor.model.capabilities.descriptors[s.descriptor].id === "/user/head/input/pose" ? [i] : []);
      return rows.every((row, i) => row.dataset.acquiredAt === String(sub.bundles[0].packet.timestamp)
        && row.querySelector(".sample-value").textContent === sub.bundles[0].values[indices[i]].map(v => v.toFixed(3)).join(", "));
    }, mixed.activeId);
    assert.equal(await page.evaluate(id => document.querySelector("subscription-editor").model.port.session.active.get(id).request.sequenceNumberFormat, mixed.activeId), 2);
    const duplicateKey = await duplicate.getAttribute("data-binding-key");
    const leftKey = await editor.locator('[data-descriptor="' + leftId + '"]').getAttribute("data-binding-key");
    const checkAppliedRow = async key => {
      await editor.locator('[data-binding-key="' + key + '"]').scrollIntoViewIfNeeded();
      await page.waitForFunction(key => {
        const editor = document.querySelector("subscription-editor"), selected = Number(editor.querySelector('[aria-pressed="true"]').dataset.key);
        const entry = editor.model.entries.find(e => e.key === selected), sub = editor.model.port.session.active.get(entry.activeId);
        let index = -1, slot = -1;
        entry.applied.bundles.forEach((bundle, i) => { const j = bundle.bindings.findIndex(row => row.key === Number(key)); if (j >= 0) { index = i; slot = j; } });
        const received = sub?.bundles[index], row = editor.querySelector('[data-binding-key="' + key + '"]');
        return received && row.dataset.acquiredAt === String(received.packet.timestamp)
          && row.querySelector(".sample-value").textContent === received.values[slot].map(v => v.toFixed(3)).join(", ")
          && !row.querySelector(".binding-state").textContent.includes("Not applied");
      }, key);
    };
    await head.first().locator('[data-action="row-remove"]').click();
    await checkAppliedRow(duplicateKey);
    await editor.locator('[data-binding-key="' + duplicateKey + '"] [data-action="row-up"]').click();
    await checkAppliedRow(duplicateKey);
    const beforeDraftArrival = await editor.locator('[data-binding-key="' + duplicateKey + '"]').getAttribute("data-acquired-at");
    await page.waitForFunction(({ key, before }) => document.querySelector('[data-binding-key="' + key + '"]').dataset.acquiredAt !== before, { key: duplicateKey, before: beforeDraftArrival });
    await editor.locator('[data-action="add-bundle"]').click();
    await addSample(page, 2, rightId);
    await editor.locator('[data-bundle-index="2"] [data-action="bundle-up"]').click();
    await checkAppliedRow(leftKey);
    await applySelected(page);
    await checkAppliedRow(leftKey);
    assert.equal(await page.evaluate(() => {
      const editor = document.querySelector("subscription-editor"), key = Number(editor.querySelector('[aria-pressed="true"]').dataset.key), entry = editor.model.entries.find(e => e.key === key);
      const sub = editor.model.port.session.active.get(entry.activeId);
      return editor.model.capabilities.descriptors[sub.request.bundles[1][0].descriptor].id;
    }), rightId);
    await editor.locator('[data-bundle-index="1"] [data-action="remove-bundle"]').click();
    await applySelected(page);
    await editor.locator('[data-action="stop"]').click();
    assert.equal((await selectedEntry(page)).activeId, undefined);
    assert.equal(await page.evaluate(id => document.querySelector("subscription-editor").model.port.session.active.has(id), replaced.activeId), true);
    await page.waitForFunction(() => [...document.querySelectorAll("subscription-editor .sample-value")].every(el => el.textContent === "—" || !el.getClientRects().length));
    assert.equal((await selectedEntry(page)).key, added.key);
  } finally {
    await page.evaluate(() => { window.restoreEditorSend(); delete window.restoreEditorSend; delete window.editorAcks; });
  }

  // Bulk catalogue adds a complete body group with qualifiers, without per-joint clicks.
  await createSubscription(page, 2);
  await editor.locator('[data-bundle-index="0"] [data-action="catalogue"]').click();
  await editor.locator('[data-field="search"]').fill("pose");
  await editor.locator('[data-field="companions"]').check();
  await editor.locator('[data-action="add-matches"]').click();
  const bulk = await page.evaluate(() => {
    const editor = document.querySelector("subscription-editor"), key = Number(editor.querySelector('[aria-pressed="true"]').dataset.key), entry = editor.model.entries.find(e => e.key === key);
    const selected = new Set(entry.draft.bundles[0].bindings.map(r => r.descriptor)), descriptors = editor.model.capabilities.descriptors;
    const poses = [...selected].filter(i => descriptors[i].kind === 10);
    return { poses: poses.length, allValid: poses.every(i => [descriptors[i].position_valid_sample, descriptors[i].orientation_valid_sample].every(q => q == null || selected.has(q))) };
  });
  assert.equal(bulk.poses, 70); assert.equal(bulk.allValid, true);
  await editor.locator('[data-action="discard"]').click();

  await selectGroup(page, 3);
  const rest = await selectedEntry(page);
  const restRow = editor.locator('[data-descriptor="/body/FB/rest/revision"]');
  await restRow.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('[data-descriptor="/body/FB/rest/revision"] .binding-state').textContent === "Retained");
  const timestamp = await restRow.getAttribute("data-acquired-at");
  await page.waitForTimeout(350);
  assert.equal((await selectedEntry(page)).packets, rest.packets);
  assert.equal(await restRow.getAttribute("data-acquired-at"), timestamp);
  assert.deepEqual((await selectedEntry(page)).bundleLengths.slice(0, 1), [0]);

  await selectGroup(page, 0);
  await head.first().locator('[data-field="format"]').selectOption("10");
  await editor.locator('[data-field="automatic"]').check();
  await editor.locator('[data-field="delivery"]').selectOption("1");
  await applySelected(page);
  await head.first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: output + "editor-desktop.png", fullPage: true });
  await editor.locator('[data-bundle-index="0"] [data-action="catalogue"]').click();
  await editor.locator('[data-field="search"]').fill("head");
  await editor.screenshot({ path: output + "editor-binding-catalogue.png" });
  await editor.locator('[data-action="close-catalogue"]').click();
  for (const width of [800, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Editor fits " + width);
    if (width === 390) await page.screenshot({ path: output + "editor-mobile.png", fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1120 });
  console.log("PASS: real editor drafts, exact duplicate values, timing-only update, fresh-id replacement/rejection, multiple subscriptions, mixed bundles/automatic ACKs, bulk companions, retained rest, responsive layout");
}
