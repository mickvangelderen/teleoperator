import assert from "node:assert/strict";

// A discovery suggestion must never redirect a synthetic test to a real device.
// Configure every context before navigation, including multi-viewer helpers.
export async function isolateSyntheticBrowser(browser, viewerUrl) {
  const viewer = new URL(viewerUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(viewer.hostname) && viewer.port !== "5173", "Use a private local viewer");
  const address = await (await fetch(new URL("/api/operator-address", viewer))).json();
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(address).hostname), "Synthetic operator must be local");
  const health = await (await fetch(new URL("/api/health", viewer), { headers: { "X-Operator-Address": address } })).json();
  assert.equal(health.source, "synthetic", "Never run browser fixtures against hardware");
  const contexts = new WeakSet(), rejected = [];
  const configure = async context => {
    if (contexts.has(context)) return;
    contexts.add(context);
    await context.addInitScript(address => sessionStorage.setItem("teleoperator.selected-operator", address), address);
    await context.route("**/api/**", route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/api/operators") return route.fulfill({ contentType: "text/event-stream", body: "data: []\n\n" });
      const selected = request.headers()["x-operator-address"];
      if ((path === "/api/offer" || path === "/api/health") && selected !== undefined && selected !== address) {
        rejected.push(selected); return route.abort("blockedbyclient");
      }
      return route.continue();
    });
  };
  const newPage = browser.newPage.bind(browser), newContext = browser.newContext.bind(browser);
  browser.newPage = async options => { const page = await newPage(options); await configure(page.context()); return page; };
  browser.newContext = async options => { const context = await newContext(options); await configure(context); return context; };
  return { address, assertIsolated() { assert.deepEqual(rejected, [], "No non-fixture operator requests were attempted"); } };
}
