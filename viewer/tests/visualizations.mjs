import assert from "node:assert/strict";

// Exercise the display policy with a partial mapped controller and unplaced raw axes.
export async function checkVisualizationChoices(page) {
  const result = await page.evaluate(async () => {
    const { Visualization } = await import("/src/visualization.ts");
    const { Session } = await import("/src/session.ts");
    const { timing } = await import("/src/protocol.ts");
    const { currentValues } = await import("/src/tracking-view.ts");
    const root = document.createElement("section");
    root.className = "workspace";
    root.innerHTML = '<p class="visualization-note"></p><div id="controller-view"></div><div id="sample-inspector"></div>';
    document.body.append(root);
    const visualization = new Visualization(root); root.prepend(visualization.label);
    const choice = root.querySelector("select");
    const descriptor = (id, kind, formats) => ({ id, kind, formats, spaces: [], group: 0, name: "Input", description: "" });
    const axis = descriptor("/user/gamepad/input/thumbstick_left/x", 1, [10]);
    const trigger = descriptor("/user/gamepad/input/trigger_left/value", 8, [10]);
    const button = descriptor("/user/gamepad/input/a/click", 2, [1]);
    const raw = descriptor("/gamepad/raw/axis/0", 1, [10]);
    function source(descriptors, bindings, values) {
      const session = new Session();
      session.receive({ tag: 2, version: 1 });
      session.receive({ tag: 3, capabilities: { descriptors, groups: [100], skeletons: [] } });
      session.request({ id: 1, ...timing(60), group: 0, delivery: 1, sequenceNumberFormat: 2,
        bundles: [[], bindings.map(i => ({ descriptor: i, format: descriptors[i].formats[0], space: 0 }))] });
      session.receive({ tag: 5, id: 1 });
      const packet = { id: 1, bundles: [null, values], timestamp: 100n, sequenceNumber: 1n, predictedFor: null };
      session.active.get(1).bundles[1] = { packet, values, arrivedAt: 100, acquiredAtArrival: 100, position: 1n, predictions: [] };
      return session;
    }
    const show = s => visualization.update(s, currentValues(s, 100), 100);
    try {
      const partial = source([axis, trigger, button, descriptor(button.id + "/active", 1, [1])], [0, 2, 3], [.75, false, false]);
      const mode = show(partial);
      const read = key => root.querySelector('[data-control="' + key + '"] span').innerText;
      const states = ["thumbstick_left", "trigger_left", "a/click", "b/click"].map(read);
      const singleAxis = root.querySelector(".stick-plane i").className;
      const unknown = source([raw], [0, 0], [-.125, .25]);
      const rawMode = show(unknown);
      const values = [...root.querySelectorAll("#sample-inspector .sample-value")].map(n => n.innerText);
      choice.value = "controller"; const fallback = show(unknown), message = root.querySelector(".visualization-note").innerText;
      const restored = show(partial);
      choice.value = "values"; const manual = show(partial);
      return { mode, states, singleAxis, rawMode, values, fallback, message, restored, manual };
    } finally { root.remove(); }
  });
  assert.deepEqual(result, { mode: "controller", states: ["X 0.750 · Y Not advertised", "Not subscribed", "Inactive", "Not advertised"],
    singleAxis: "x-only", rawMode: "values", values: ["-0.125", "0.25"], fallback: "values",
    message: "Controller unavailable for this operator. Showing sample values.", restored: "controller", manual: "values" });
}

export async function checkXRVisualization(page) {
  const workspace = page.locator(".workspace"), picker = page.getByLabel("Visualization", { exact: true });
  await page.waitForFunction(() => document.querySelector(".workspace").dataset.view === "spatial");
  await picker.selectOption("values");
  const head = workspace.locator('.observed-sample:has(> [data-sample-id="/user/head/input/pose"])');
  await head.locator('[data-sample-id$="/position_valid"] .sample-value').filter({ hasText: "true" }).waitFor();
  assert.equal(await head.locator("[data-sample-id]").count(), 5);
  const accepted = await workspace.locator(".inspect-selector select").inputValue();
  const editor = page.locator("subscription-editor");
  await editor.locator('[data-action="select"][data-group="0"]').first().click();
  await editor.locator('[data-action="clear-bundle"]').first().click();
  assert.equal(await editor.locator("[data-binding-key]").count(), 0);
  assert.equal(await head.locator("[data-sample-id]").count(), 5);
  await picker.selectOption("controller");
  await page.locator(".visualization-note").filter({ hasText: "Controller unavailable" }).waitFor();
  assert.equal(await workspace.locator(".inspect-selector select").inputValue(), accepted);
  await editor.locator('[data-action="discard"]').click();
  await picker.selectOption("auto");
  await page.waitForFunction(() => document.querySelector(".workspace").dataset.view === "spatial");
}
