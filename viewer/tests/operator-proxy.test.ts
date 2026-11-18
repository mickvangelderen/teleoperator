import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createServer as createVite } from "vite";
import { operatorProxy } from "../tools/operator-proxy";
import { operatorOrigin } from "../src/operator-address";

async function listen(t: TestContext, handle: RequestListener) {
  const server = createServer(handle);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("operator addresses identify an HTTP(S) origin", () => {
  assert.equal(operatorOrigin(" HTTP://LOCALHOST:80/ "), "http://localhost");
  assert.equal(operatorOrigin("https://[::1]:8080"), "https://[::1]:8080");
  for (const address of ["", "http:/", "ws://host", "http://x@y", "http://host/path",
    "http://host?", "http://host#", "http://host:65536", "http://host/.."]) {
    assert.throws(() => operatorOrigin(address));
  }
});

test("concurrent viewer requests use independent origins and forward only operator traffic", async t => {
  const requests: string[] = [];
  const operator = (name: string) => listen(t, (req, res) => {
    requests.push(`${name} ${req.method} ${req.url}`);
    for (const header of ["origin", "cookie", "authorization", "x-operator-address"]) assert.equal(req.headers[header], undefined);
    res.setHeader("Set-Cookie", "test=upstream");
    res.end(name);
  });
  const first = await operator("first"), second = await operator("second");
  const vite = await createVite({ configFile: false, plugins: [operatorProxy(first)], server: { middlewareMode: true, hmr: false } });
  t.after(() => vite.close());
  const viewer = await listen(t, vite.middlewares);
  assert.equal(await (await fetch(viewer + "/api/operator-address")).json(), first);
  await Promise.all([first, second].map(async address => {
    const headers: Record<string, string> = { Origin: viewer, Cookie: "private=1", Authorization: "test", "Content-Type": "application/json" };
    if (address === second) headers["X-Operator-Address"] = address;
    for (const [route, method] of [["health", "GET"], ["offer", "POST"]]) {
      const response = await fetch(viewer + "/api/" + route, { method, headers });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Set-Cookie"), null);
      assert.equal(await response.text(), address === first ? "first" : "second");
    }
  }));
  assert.deepEqual(requests.sort(), ["first GET /health", "first POST /offer", "second GET /health", "second POST /offer"]);
  for (const [path, options, status] of [
    ["/offer", { method: "POST", headers: { Origin: "http://another.test", "Content-Type": "application/json" } }, 403],
    ["/health", { headers: { "X-Operator-Address": second + "/other" } }, 400],
    ["/offer", { method: "POST", body: "text" }, 415],
    ["/other", {}, 404],
  ] as const) {
    assert.equal((await fetch(viewer + "/api" + path, options)).status, status);
  }
  assert.equal(requests.length, 4);
});
