import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile, utimes, stat, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recordingMiddleware } from "../tools/recording-server";
import { recordingId } from "../src/recording";
import { recordingBatchBytes, stringifyRecording } from "../src/recording-format";
import { Session } from "../src/session";
import { decodeTracking, periodic } from "../src/protocol";
import type { Capabilities, Request } from "../src/protocol";

async function endpoint(limit?: number, setup?: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "xr-recording-"));
  await setup?.(directory);
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
    const first = await readFile(join(e.directory, e.id + ".000000.jsonl"), "utf8");
    assert.equal((await e.post(header + packet)).status, 200);
    assert.equal(await readFile(join(e.directory, e.id + ".000000.jsonl"), "utf8"), first);
    assert.equal((await e.post(header)).status, 409);
    const timing = JSON.stringify({ type: "timing", sequence: 2, atMs: 2, metric: "render", durationMs: 3 }) + "\n";
    assert.equal((await e.post(timing, 2)).status, 409);
    assert.equal((await e.post(timing, 1)).status, 200);
    const records = (await readFile(join(e.directory, e.id + ".000000.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
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
    assert.equal((await e.post("x".repeat(recordingBatchBytes + 1))).status, 413);
    assert.deepEqual(await readdir(e.directory), []);
    assert.equal((await e.post(header)).status, 200, "Rejected requests must not advance the recording");
  } finally { await e.close(); }
});

test("recording rejects a batch that cannot fit the storage budget", async () => {
  const e = await endpoint(1);
  try {
    assert.equal((await e.post(header)).status, 507);
    assert.deepEqual(await readdir(e.directory), []);
  } finally { await e.close(); }
});

const checkpoint = (sequence: number, state: object = { connections: [] }) => stringifyRecording({ type: "checkpoint", version: 1, sequence, atMs: sequence, state }) + "\n";
const timing = (sequence: number, padding = 600) => JSON.stringify({ type: "timing", sequence, atMs: sequence, padding: "é".repeat(padding) }) + "\n";
const end = (sequence: number) => JSON.stringify({ type: "recording-end", sequence, atMs: sequence, reason: "test" }) + "\n";
const filenames = (e: { directory: string }) => readdir(e.directory).then(files => files.sort());
async function diskBytes(e: { directory: string }) {
  return (await Promise.all((await filenames(e)).map(name => stat(join(e.directory, name))))).reduce((sum, info) => sum + info.size, 0);
}

test("continuous capture rotates and prunes complete chunks, including UTF-8 byte accounting", async () => {
  const e = await endpoint(4000);
  try {
    assert.equal((await e.post(header + checkpoint(1) + timing(2))).status, 200);
    for (let batch = 1; batch <= 12; batch++) {
      const body = checkpoint(2 * batch + 1) + timing(2 * batch + 2);
      const response = await e.post(body, batch);
      assert.equal(response.status, 200, await response.clone().text());
      const ack = await response.json();
      assert.equal(ack.file, `${e.id}.${String(batch).padStart(6, "0")}.jsonl`);
      assert.ok(await diskBytes(e) <= 4000);
      const before = await filenames(e);
      assert.equal((await e.post(body, batch)).status, 200);
      assert.deepEqual(await filenames(e), before, "retry must not rotate twice");
      for (const name of before) {
        const text = await readFile(join(e.directory, name), "utf8");
        assert.ok(text.endsWith("\n"));
        const records = text.trimEnd().split("\n").map(line => JSON.parse(line));
        assert.equal(records[0].version, 2);
        assert.equal(records[0].firstSequence, records[1].sequence);
        assert.equal(records[0].session.timeOrigin, 1234);
      }
      if (batch > 1) assert.ok(ack.pruned > 0);
    }
    assert.deepEqual(await filenames(e), [`${e.id}.000011.jsonl`, `${e.id}.000012.jsonl`]);
  } finally { await e.close(); }
});

test("pruning includes legacy files oldest first and leaves unrelated files and active chunks alone", async () => {
  const oldest = randomUUID() + ".jsonl", newer = randomUUID() + ".jsonl";
  const e = await endpoint(4000, async directory => {
    await writeFile(join(directory, oldest), "x".repeat(1500));
    await writeFile(join(directory, newer), "y".repeat(1500));
    await writeFile(join(directory, "notes.jsonl"), "keep");
    await utimes(join(directory, oldest), 1, 1);
    await utimes(join(directory, newer), 2, 2);
  });
  try {
    const first = await e.post(header + checkpoint(1) + timing(2));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).pruned, 1);
    assert.deepEqual(await filenames(e), [e.id + ".000000.jsonl", newer, "notes.jsonl"].sort());
    const secondId = randomUUID();
    assert.equal((await e.post(header + checkpoint(1) + timing(2), 0, {}, secondId)).status, 200);
    assert.ok((await filenames(e)).includes(e.id + ".000000.jsonl"));
    assert.ok(!(await filenames(e)).includes(newer));
    assert.equal(await readFile(join(e.directory, "notes.jsonl"), "utf8"), "keep");
    const files = await filenames(e);
    assert.equal((await e.post(header + timing(1), 0, {}, randomUUID())).status, 507);
    assert.deepEqual(await filenames(e), files, "space pressure must not delete active chunks");
  } finally { await e.close(); }
});

test("concurrent tabs serialize pruning and rotation without exceeding the budget", async () => {
  const e = await endpoint(4000), other = randomUUID();
  try {
    const starts = await Promise.all([e.post(header + checkpoint(1) + timing(2)), e.post(header + checkpoint(1) + timing(2), 0, {}, other)]);
    assert.deepEqual(starts.map(r => r.status), [200, 200]);
    for (let batch = 1; batch < 6; batch++) {
      const body = checkpoint(2 * batch + 1) + timing(2 * batch + 2);
      const responses = await Promise.all([e.post(body, batch), e.post(body, batch, {}, other)]);
      assert.deepEqual(responses.map(r => r.status), [200, 200]);
      assert.ok(await diskBytes(e) <= 4000);
      assert.deepEqual(await filenames(e), [e.id, other].map(id => `${id}.${String(batch).padStart(6, "0")}.jsonl`).sort());
    }
  } finally { await e.close(); }
});

test("a retry of an evicted completed capture is acknowledged without recreating it", async () => {
  const e = await endpoint(2300);
  try {
    const body = header + checkpoint(1) + timing(2) + end(3);
    const original = await e.post(body);
    assert.equal(original.status, 200);
    const ack = await original.json();
    assert.equal((await e.post(body, 0, {}, randomUUID())).status, 200);
    assert.ok(!(await filenames(e)).includes(ack.file));
    const retry = await e.post(body);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).file, ack.file);
    assert.ok(!(await filenames(e)).includes(ack.file));
  } finally { await e.close(); }
});

test("closed and abandoned sessions do not exhaust the lifetime session count", async context => {
  const e = await endpoint();
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  try {
    for (let i = 0; i < 140; i++) assert.equal((await e.post(header + end(1), 0, {}, randomUUID())).status, 200);
    for (let i = 0; i < 64; i++) assert.equal((await e.post(header, 0, {}, randomUUID())).status, 200);
    assert.equal((await e.post(header)).status, 429);
    now += 5 * 60_000 + 1;
    assert.equal((await e.post(header)).status, 200);
  } finally { await e.close(); }
});

test("malformed chunk boundaries cannot prune existing history", async () => {
  const e = await endpoint(4000);
  try {
    assert.equal((await e.post(header + checkpoint(1) + timing(2))).status, 200);
    const before = await filenames(e);
    assert.equal((await e.post(timing(3) + checkpoint(4), 1)).status, 400);
    assert.equal((await e.post(end(3) + timing(4), 1)).status, 400);
    assert.deepEqual(await filenames(e), before);
    assert.equal((await e.post(checkpoint(3) + timing(4), 1)).status, 200);
  } finally { await e.close(); }
});

test("missing active files fail instead of recreating a chunk without its header", async () => {
  const e = await endpoint();
  try {
    assert.equal((await e.post(header)).status, 200);
    await rm(join(e.directory, e.id + ".000000.jsonl"));
    assert.equal((await e.post(timing(1), 1)).status, 500);
    assert.deepEqual(await filenames(e), []);
    assert.equal((await e.post(timing(1), 1)).status, 410);
  } finally { await e.close(); }
});

test("deletion failures are reported and do not acknowledge an unwritten batch", async () => {
  const legacy = randomUUID() + ".jsonl";
  const e = await endpoint(2300, async directory => { await writeFile(join(directory, legacy), "x".repeat(2000)); });
  try {
    await rm(join(e.directory, legacy));
    await mkdir(join(e.directory, legacy));
    const body = header + checkpoint(1) + timing(2);
    assert.equal((await e.post(body)).status, 500);
    assert.deepEqual(await filenames(e), [legacy]);
    await rm(join(e.directory, legacy), { recursive: true });
    assert.equal((await e.post(body)).status, 200, "retry after cleanup failure must still accept batch zero");
  } finally { await e.close(); }
});

test("a retained checkpoint decodes packets and retains on-change poses after earlier chunks are deleted", async () => {
  const c: Capabilities = { groups: [60, 60], skeletons: [], descriptors: [
    { id: "rest", name: "rest", description: "", kind: 10, group: 0, formats: [10], spaces: [2] },
    { id: "count", name: "count", description: "", kind: 3, group: 1, formats: [5], spaces: [] },
  ] };
  const s = new Session();
  s.receive({ tag: 2, version: 1 }); s.receive({ tag: 3, capabilities: c });
  const rest: Request = { id: 1, group: 0, delivery: 2, schedule: { kind: "onChange" }, samples: [{ descriptor: 0, format: 10, space: 2 }] };
  const moving: Request = { id: 2, group: 1, delivery: 1, schedule: periodic(60), samples: [{ descriptor: 1, format: 5, space: 0 }] };
  for (const request of [rest, moving]) { s.request(request); s.receive({ tag: 5, id: request.id }); }
  const at = 2n ** 54n;
  const pose = Buffer.alloc(49); pose[0] = 9; pose.writeUInt32LE(1, 1); pose.writeBigUInt64LE(at, 5); pose.writeBigUInt64LE(0xffffffffffffffffn, 13);
  [1, 2, 3, 0, 0, 0, 1].forEach((value, i) => pose.writeFloatLE(value, 21 + 4 * i));
  s.control(pose, 10);
  s.clock = { offset: at, delay: 100n, at: 10 }; s.requestClock(11);
  s.request({ ...moving, id: 3 });
  const state = { connections: [{ connection: randomUUID(), session: s.checkpoint() }] };
  const packet = Buffer.alloc(29); packet[0] = 9; packet.writeUInt32LE(2, 1); packet.writeBigUInt64LE(at + 1n, 5);
  packet.writeBigUInt64LE(0xffffffffffffffffn, 13); packet.writeBigUInt64LE(at + 2n, 21);
  const next = JSON.stringify({ type: "packet", sequence: 4, atMs: 12, base64: packet.toString("base64") }) + "\n";
  const body = checkpoint(3, state) + next;
  const e = await endpoint(Buffer.byteLength(body) + 700);
  try {
    assert.equal((await e.post(header + checkpoint(1) + timing(2))).status, 200);
    const response = await e.post(body, 1);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await filenames(e), [e.id + ".000001.jsonl"]);
    const records = (await readFile(join(e.directory, e.id + ".000001.jsonl"), "utf8")).trimEnd().split("\n")
      .map(line => JSON.parse(line, (_key, value) => value && typeof value === "object" && typeof value.$bigint === "string" ? BigInt(value.$bigint) : value));
    const snapshot = records[1].state.connections[0].session as ReturnType<Session["checkpoint"]>;
    assert.deepEqual(snapshot.active[0].packet?.values, [[1, 2, 3, 0, 0, 0, 1]]);
    assert.equal(snapshot.active[0].packet?.timestamp, at);
    assert.equal(snapshot.clock?.offset, at);
    assert.equal(snapshot.clockRequests.length, 1);
    assert.equal(snapshot.pending[0].id, 3);
    const decoded = decodeTracking(Buffer.from(records[2].base64, "base64").subarray(1), snapshot.capabilities!, snapshot.active[1].request);
    assert.equal(decoded.timestamp, at + 1n);
    assert.deepEqual(decoded.values, [at + 2n]);
  } finally { await e.close(); }
});
