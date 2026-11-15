import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { Connection } from "../src/connection";
import { Recorder, MAX_RECORDING_BATCH_BYTES, MAX_RECORDING_BYTES, RECORDING_HEADER, RECORD_HEADER_BYTES } from "../src/recording";
import { recordingMiddleware } from "../tools/recording-server";

function frames(bytes: Uint8Array, header = true) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const messages: { flags: number; time: number; bytes: Uint8Array }[] = [];
  let at = header ? RECORDING_HEADER.length : 0;
  if (header) assert.deepEqual(bytes.subarray(0, at), RECORDING_HEADER);
  while (at < bytes.length) {
    assert.ok(bytes.length - at >= RECORD_HEADER_BYTES, "Complete frame header");
    const length = view.getUint32(at, true), flags = bytes[at + 4], time = view.getFloat64(at + 5, true);
    at += RECORD_HEADER_BYTES;
    assert.ok(length <= bytes.length - at, "Complete message payload");
    messages.push({ flags, time, bytes: bytes.slice(at, at + length) });
    at += length;
  }
  return messages;
}

function frame(bytes: Uint8Array, flags = 0, time = 1) {
  const result = Buffer.alloc(RECORD_HEADER_BYTES + bytes.length);
  result.writeUInt32LE(bytes.length); result[4] = flags; result.writeDoubleLE(time, 5);
  result.set(bytes, RECORD_HEADER_BYTES);
  return result;
}

function captureUploads(context: TestContext) {
  const batches: Uint8Array[] = [];
  context.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    if (!String(url).startsWith("/__dev/recordings/")) return Response.json({ type: "answer", sdp: "test" });
    const body = init.body as Uint8Array;
    const offset = Number((init.headers as Record<string, string>)["X-Recording-Offset"]);
    assert.equal(offset, batches.reduce((sum, batch) => sum + batch.length, 0));
    assert.ok(body.length <= MAX_RECORDING_BATCH_BYTES);
    batches.push(body);
    return Response.json({ bytes: offset + body.length });
  });
  return () => new Uint8Array(Buffer.concat(batches));
}

test("binary capture preserves bytes, subarray boundaries, channel/direction and observed order", async context => {
  const recorded = captureUploads(context);
  context.mock.method(performance, "now", () => 100);
  const recorder = new Recorder();
  try {
    const source = Uint8Array.of(77, 0, 255, 128, 33);
    recorder.packet("received", "reliable", source.subarray(1, 4), 101.25);
    recorder.packet("sent", "unreliable", Uint8Array.of(10, 0, 0, 0, 0), 101.25);
    recorder.packet("received", "unreliable", new Uint8Array(), 102);
    recorder.packet("sent", "reliable", source.subarray(3, 4), 103.5);
    source.fill(0);
    await recorder.stop();
    assert.deepEqual(frames(recorded()), [
      { flags: 0, time: 1.25, bytes: Uint8Array.of(0, 255, 128) },
      { flags: 3, time: 1.25, bytes: Uint8Array.of(10, 0, 0, 0, 0) },
      { flags: 1, time: 2, bytes: new Uint8Array() },
      { flags: 2, time: 3.5, bytes: Uint8Array.of(128) },
    ]);
    assert.equal(recorder.savedBytes, RECORDING_HEADER.length + 4 * RECORD_HEADER_BYTES + 9);
    assert.equal(recorder.savedBytes, recorder.bytes);
  } finally { await recorder.stop(); }
});

test("the 128 MiB cap includes all framing and permanently stops before the first message that does not fit", async context => {
  let saved = 0, count = 0;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = init.body as Uint8Array;
    assert.equal(Number((init.headers as Record<string, string>)["X-Recording-Offset"]), saved);
    count += frames(body, !saved).length;
    saved += body.length;
    assert.ok(saved <= MAX_RECORDING_BYTES);
    return Response.json({ bytes: saved });
  });
  for (const remaining of [0, 100]) {
    saved = count = 0;
    const recorder = new Recorder(), payload = new Uint8Array(1024 ** 2 - RECORD_HEADER_BYTES);
    try {
      for (let i = 0; i < 127; i++) {
        recorder.packet("received", "unreliable", payload);
        await recorder.flush();
      }
      recorder.packet("received", "reliable", new Uint8Array(MAX_RECORDING_BYTES - recorder.bytes - RECORD_HEADER_BYTES - remaining));
      await recorder.flush();
      assert.equal(recorder.status, "recording");
      recorder.packet("received", "unreliable", new Uint8Array(remaining));
      recorder.packet("sent", "reliable", new Uint8Array()); // Must not resume even when this smaller message fits.
      await recorder.stop();
      assert.equal(recorder.status, "limit");
      assert.equal(saved, MAX_RECORDING_BYTES - remaining);
      assert.equal(recorder.bytes, saved);
      assert.equal(count, 128);
    } finally { await recorder.stop(); }
  }
});

test("a slow writer bounds pending memory and saves its complete prefix", async context => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const batches: Uint8Array[] = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = init.body as Uint8Array;
    batches.push(body);
    await gate;
    return Response.json({ bytes: Number((init.headers as Record<string, string>)["X-Recording-Offset"]) + body.length });
  });
  const recorder = new Recorder();
  try {
    recorder.packet("received", "reliable", new Uint8Array(1024 ** 2));
    recorder.packet("received", "unreliable", new Uint8Array(1024 ** 2));
    assert.equal(recorder.status, "error");
    assert.match(recorder.error, /could not keep up/);
    release();
    await recorder.stop();
    assert.equal(frames(new Uint8Array(Buffer.concat(batches))).length, 1);
    assert.equal(recorder.bytes, recorder.savedBytes);
  } finally { release(); await recorder.stop(); }
});

test("upload failures stop capture without throwing into message handling", async context => {
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Disk unavailable"); });
  const recorder = new Recorder();
  await recorder.flush();
  assert.equal(recorder.status, "error");
  assert.match(recorder.error, /Disk unavailable/);
  recorder.packet("received", "reliable", Uint8Array.of(1));
  await recorder.stop();
  assert.equal(recorder.bytes, RECORDING_HEADER.length);
});

test("connection capture includes negotiation and subscription requests before interleaved channel traffic", async context => {
  const recorded = captureUploads(context), expected: { flags: number; bytes: Uint8Array }[] = [];
  class Channel {
    onopen?: () => void;
    onmessage?: (event: { data: ArrayBuffer }) => void;
    readyState = "open"; bufferedAmount = 0; throwing = false;
    constructor(readonly flags: number) {}
    send(bytes: Uint8Array) {
      if (this.throwing) throw new Error("Send failed");
      expected.push({ flags: this.flags | 2, bytes: bytes.slice() });
    }
    receive(bytes: Uint8Array) {
      expected.push({ flags: this.flags, bytes: bytes.slice() });
      this.onmessage!({ data: bytes.slice().buffer });
    }
  }
  class Peer {
    static latest: Peer;
    control = new Channel(0); tracking = new Channel(1); closed = false;
    sctp = { maxMessageSize: 65536 }; iceGatheringState = "complete";
    localDescription = { type: "offer", sdp: "test" };
    constructor() { Peer.latest = this; }
    createDataChannel(label: string) { return label === "reliable" ? this.control : this.tracking; }
    async createOffer() { return this.localDescription; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    addEventListener() {}
    removeEventListener() {}
    close() { this.closed = true; }
  }
  const originalPeer = globalThis.RTCPeerConnection;
  Object.assign(globalThis, { RTCPeerConnection: Peer });
  const recorder = new Recorder(), connection = new Connection(() => {}, recorder);
  try {
    await connection.connect();
    const peer = Peer.latest;
    peer.control.onopen!(); peer.tracking.onopen!();
    const spec = JSON.parse(readFileSync(new URL("../../protocol/testdata/specification-v1.json", import.meta.url), "utf8"));
    const wire = (name: string) => Uint8Array.from(Buffer.from(spec.records.find((r: { name: string }) => r.name === name).hex, "hex"));
    peer.control.receive(wire("selection"));
    peer.control.receive(wire("capabilities_poses"));
    peer.control.receive(Uint8Array.of(5, 1, 0, 0, 0));
    peer.tracking.receive(Uint8Array.of(255, 0, 127)); // Invalid wire packets are still captured.
    peer.control.receive(Uint8Array.of(8, 99, 0, 0, 0, 1, 0, 0, 0, 97));
    assert.equal(connection.state.status, "Connected", connection.state.detail);
    await recorder.stop("limit");
    const before = recorder.bytes;
    peer.tracking.onmessage!({ data: Uint8Array.of(0).buffer });
    assert.equal(connection.state.status, "Connected");
    assert.equal(peer.closed, false, "Stopping capture leaves WebRTC running");
    assert.equal(recorder.bytes, before);
    const actual = frames(recorded());
    assert.deepEqual(actual.map(({ flags, bytes }) => ({ flags, bytes })), expected);
    assert.deepEqual(actual.slice(0, 5).map(message => [message.flags, message.bytes[0]]), [[2, 1], [0, 2], [0, 3], [3, 10], [2, 4]]);
    assert.ok(actual.every((message, index) => !index || message.time >= actual[index - 1].time));
  } finally {
    connection.close(); await recorder.stop();
    Object.assign(globalThis, { RTCPeerConnection: originalPeer });
  }
});

test("development writer appends verbatim complete batches and rejects invalid, out-of-order and oversized writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xr-recording-"));
  const middleware = await recordingMiddleware(directory);
  const server = createServer((req, res) => { void middleware(req, res, () => { res.writeHead(404); res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number }, origin = `http://127.0.0.1:${address.port}`;
  const id = "0123456789abcdef0123456789abcdef", path = join(directory, `${id}.xrop`);
  const post = (body: Uint8Array, offset: number, extra: Record<string, string> = {}) => fetch(`${origin}/__dev/recordings/${id}`, {
    method: "POST", body: body as Uint8Array<ArrayBuffer>,
    headers: { Origin: origin, "Content-Type": "application/octet-stream", "X-XR-Recording": "1", "X-Recording-Offset": String(offset), ...extra },
  });
  try {
    const first = Buffer.concat([RECORDING_HEADER, frame(Uint8Array.of(0, 255), 2)]);
    assert.equal((await post(first, 0, { Origin: "http://another-host" })).status, 403);
    assert.equal((await post(first, 0)).status, 200);
    assert.deepEqual(await readFile(path), first);
    const second = frame(Uint8Array.of(128, 19, 0), 1, 2.5);
    assert.equal((await post(second.subarray(0, second.length - 1), first.length)).status, 400);
    assert.equal((await post(second, first.length - 1)).status, 409);
    assert.equal((await post(second, first.length)).status, 200);
    assert.equal((await post(second, first.length)).status, 409);
    assert.deepEqual(await readFile(path), Buffer.concat([first, second]));
    // A sparse valid file tests the independent server cap without sending 128 MiB over HTTP.
    const lastLength = MAX_RECORDING_BYTES - first.length - RECORD_HEADER_BYTES;
    const lastHeader = frame(new Uint8Array()); lastHeader.writeUInt32LE(lastLength);
    await writeFile(path, Buffer.concat([first, lastHeader]));
    const file = await open(path, "r+");
    await file.truncate(MAX_RECORDING_BYTES); await file.close();
    assert.equal((await post(second, MAX_RECORDING_BYTES)).status, 413);
    assert.equal((await stat(path)).size, MAX_RECORDING_BYTES);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
