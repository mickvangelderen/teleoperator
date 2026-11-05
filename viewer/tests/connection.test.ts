import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Connection } from "../src/connection";
import type { Accepted, Capabilities, Received, Tracking } from "../src/protocol";
import { profiler } from "../src/performance";
import { MAX_PACKET, VERSION } from "../src/protocol";

class Channel {
  readyState = "open";
  bufferedAmount = 0;
  sent: Uint8Array[] = [];
  send(data: Uint8Array) { this.sent.push(data); }
}
const originalPeer = globalThis.RTCPeerConnection;
globalThis.RTCPeerConnection = class {
  createDataChannel() { return new Channel(); }
  close() {}
} as unknown as typeof RTCPeerConnection;
after(() => { globalThis.RTCPeerConnection = originalPeer; });

// Exercise the message-routing boundary with a transport double; encoding has separate tests.
function fixture() {
  const connection = new Connection(() => {});
  const receiver = connection as unknown as {
    accept(message: Received): void;
    acceptTracking(message: Tracking, bytes: number, arrivedAt: number): void;
    probe(): void;
    probes: Map<bigint, number>;
    probeId: bigint;
    offset: number | null;
    control: Channel;
    tracking: Channel;
  };
  connection.state.hello = { kind: "ServerHello", requestId: 1n, selectedVersion: VERSION,
    supportedVersions: [VERSION], reason: "", session: { low: 1n, high: 2n } };
  return { connection, receiver };
}
const capabilities = (body = true): Capabilities => ({
  kind: "Capabilities", sampleRate: 200, controller: false, pose: false,
  body: body ? { source: "body", jointSet: "test" } : false,
  spaces: [{ id: 1n, spaceKind: 3 }], publication: { sendRateHz: 100, historyLength: 2 },
  limits: { minSendRateHz: 1, maxSendRateHz: 200, maxHistoryLength: 8,
    maxTrackingMessageBytes: MAX_PACKET, maxControlMessageBytes: MAX_PACKET, maxStreamsPerClient: 3 },
});
const accepted = (requestId: bigint, streamId: bigint): Accepted => ({
  kind: "StreamAccepted", type: "body", requestId, streamId, sources: ["body"], inputs: [],
  reference: { id: 1n, version: 1 }, skeleton: { id: 2n, version: 1 }, jointSet: "test", rate: 100, history: 1,
});

test("clock filter replaces old minima, ignores duplicates, expires and exceeds the former probe budget", t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const { connection, receiver } = fixture();
  try {
    function reply(id: bigint, rtt: number, offset: number) {
      now += 1000;
      receiver.probes.set(id, now - rtt);
      const server = BigInt(Math.round((now - rtt / 2 + offset) * 1e6));
      receiver.accept({ kind: "ClockReply", requestId: id, receivedAt: server, sentAt: server });
    }
    reply(1n, 1, 10);
    for (let id = 2n; id <= 8n; id++) reply(id, 10, 30);
    assert.equal(receiver.offset, 10);
    reply(9n, 10, 30);
    assert.equal(receiver.offset, 30, "Old best RTT must age out after eight replies");
    receiver.accept({ kind: "ClockReply", requestId: 9n, receivedAt: 0n, sentAt: 0n });
    assert.equal(receiver.offset, 30, "Duplicate replies do not change the mapping");
    receiver.probeId = 65_536n;
    receiver.probe();
    assert.equal(receiver.probeId, 65_537n);
    assert.notEqual(connection.state.status, "Error");
    now += 6000;
    receiver.tracking.bufferedAmount = MAX_PACKET;
    receiver.probe();
    assert.equal(receiver.offset, null, "Expiry works even when outbound probes are blocked");
    assert.equal(connection.state.rtt, null);
    reply(10n, 20, 50);
    receiver.accept({ kind: "ServerResumed" });
    assert.equal(receiver.offset, null);
    assert.equal(receiver.probes.size, 0);
  } finally { connection.close(); }
});

test("capability loss resubscribes on restoration while explicit unsubscribe stays stopped", () => {
  const { connection, receiver } = fixture();
  try {
    receiver.accept(capabilities());
    receiver.accept(accepted(2n, 10n));
    receiver.accept(capabilities(false));
    receiver.accept({ kind: "StreamClosed", requestId: 0n, streamId: 10n });
    assert.equal(connection.state.streams.length, 0);
    receiver.accept(capabilities());
    assert.equal(receiver.control.sent.length, 2, "Restore sends another subscribe");
    receiver.accept(accepted(3n, 11n));
    connection.stopTracking("body");
    receiver.accept({ kind: "StreamClosed", requestId: 4n, streamId: 11n });
    receiver.accept(capabilities());
    assert.equal(receiver.control.sent.length, 3, "Explicit stop does not resubscribe");
  } finally { connection.close(); }
});

test("recenter needs no metadata message, while body still requires its exact skeleton", t => {
  const arrival = t.mock.method(profiler, "trackingArrival");
  const { connection, receiver } = fixture();
  try {
    receiver.accept(capabilities()); receiver.accept(accepted(2n, 10n));
    const pose = { position: [0, 1, 0], orientation: [0, 0, 0, 1], flags: 15, active: null };
    receiver.accept({ kind: "SkeletonDefinition", id: 2n, version: 1, reference: { id: 1n, version: 1 },
      jointSet: "test", joints: [{ id: 0, parent: -1, name: "root", rest: pose }] });
    const message: Tracking = { kind: "Tracking", streamId: 10n, messageNumber: 1n, samples: [{
      type: "body", number: 100n, acquiredAt: 0n, targetAt: null, referenceVersion: 99, poses: [pose], inputs: [],
      body: { active: true, confidence: 1, returnedAt: null, skeletonVersion: 1, fidelity: null, calibration: null },
    }] };
    receiver.acceptTracking(message, 128, 1000);
    const [kind, key, bytes, at] = arrival.mock.calls[0].arguments;
    assert.equal(kind, "body"); assert.match(key, /^[a-f0-9-]+:10$/);
    assert.equal(bytes, 128); assert.equal(at, 1000);
    assert.equal(connection.state.streams[0].newest, 100n);
    message.messageNumber = 2n; message.samples[0].number = 101n; message.samples[0].body!.skeletonVersion = 2;
    receiver.acceptTracking(message, 128, 1010);
    assert.equal(connection.state.streams[0].newest, 100n);
    assert.equal(connection.state.streams[0].statistics.discarded, 1);
  } finally { connection.close(); }
});


test("publication acknowledgements cannot replace a stream's selection", () => {
  const { connection, receiver } = fixture();
  try {
    receiver.accept(capabilities()); receiver.accept(accepted(2n, 10n));
    connection.setPublication(30, 1, "body");
    assert.throws(() => receiver.accept({ ...accepted(3n, 10n), sources: ["other"] }), /acquisition changed/);
    assert.deepEqual(connection.state.streams[0].descriptor.sources, ["body"]);
  } finally { connection.close(); }
});
