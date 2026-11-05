import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recordingMiddleware } from "../tools/recording-server";
import { recordingId } from "../src/recording";

async function endpoint(limit?: number) {
  const directory = await mkdtemp(join(tmpdir(), "xr-recording-"));
  const middleware = await recordingMiddleware(directory, limit, "test-revision");
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`, id = randomUUID();
  return {
    directory, id,
    post: (body: string, batch = 0, headers: Record<string, string> = {}, path: string = id) => fetch(`${origin}/__dev/recordings/${path}`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/x-ndjson", "X-XR-Recording": "1", "X-Recording-Batch": String(batch), ...headers }, body,
    }),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const header = JSON.stringify({ type: "session", sequence: 0, atMs: 0, version: 1, timeOrigin: 1234 }) + "\n";

test("recording IDs remain available without secure-context randomUUID", context => {
  context.mock.method(crypto, "randomUUID", () => { throw new Error("Unavailable on HTTP LAN origins"); });
  const id = recordingId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(recordingId(), id);
});

test("recording writes ordered JSONL and acknowledges retries without duplicating bytes", async () => {
  const e = await endpoint();
  try {
    const packet = JSON.stringify({ type: "packet", sequence: 1, atMs: 1, base64: "AAECAw==" }) + "\n";
    assert.equal((await e.post(header + packet)).status, 200);
    const first = await readFile(join(e.directory, e.id + ".jsonl"), "utf8");
    assert.equal((await e.post(header + packet)).status, 200);
    assert.equal(await readFile(join(e.directory, e.id + ".jsonl"), "utf8"), first);
    assert.equal((await e.post(header)).status, 409);
    const timing = JSON.stringify({ type: "timing", sequence: 2, atMs: 2, metric: "render", durationMs: 3 }) + "\n";
    assert.equal((await e.post(timing, 2)).status, 409);
    assert.equal((await e.post(timing, 1)).status, 200);
    const records = (await readFile(join(e.directory, e.id + ".jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.equal(records[0].revision, "test-revision");
    assert.deepEqual(records.slice(1).map(record => record.sequence), [0, 1, 2]);
    assert.deepEqual([...Buffer.from(records[2].base64, "base64")], [0, 1, 2, 3]);
  } finally { await e.close(); }
});

test("recording rejects foreign origins, paths, malformed batches, gaps and oversized requests", async () => {
  const e = await endpoint();
  try {
    assert.equal((await e.post(header, 0, { Origin: "https://other.example" })).status, 403);
    assert.equal((await e.post(header, 0, { "X-XR-Recording": "" })).status, 403);
    assert.equal((await e.post(header, 0, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await e.post(header, 0, {}, "%2e%2e%2fcapture")).status, 400);
    assert.equal((await e.post("invalid\n")).status, 400);
    assert.equal((await e.post(header.trim())).status, 400);
    assert.equal((await e.post(header.replace('"sequence":0', '"sequence":9'))).status, 400);
    assert.equal((await e.post("x".repeat(1024 * 1024 + 1))).status, 413);
    assert.deepEqual(await readdir(e.directory), []);
    assert.equal((await e.post(header)).status, 200, "Rejected requests must not advance the recording");
  } finally { await e.close(); }
});

test("recording stops at its storage budget without deleting or truncating earlier captures", async () => {
  const e = await endpoint(1);
  try {
    assert.equal((await e.post(header)).status, 507);
    assert.deepEqual(await readdir(e.directory), []);
  } finally { await e.close(); }
});
