import assert from "node:assert/strict";
import { test } from "node:test";
import { Builder, ByteBuffer } from "flatbuffers";
import { decode, encode, MAX_PACKET } from "../src/protocol";
import { Packet } from "../src/generated/xr-operator/wire/packet";
import { Message } from "../src/generated/xr-operator/wire/message";
import { ClientHello } from "../src/generated/xr-operator/wire/client-hello";
import { ServerHello } from "../src/generated/xr-operator/wire/server-hello";
import { SessionId } from "../src/generated/xr-operator/wire/session-id";
import { ClockReply } from "../src/generated/xr-operator/wire/clock-reply";
import { Capabilities } from "../src/generated/xr-operator/wire/capabilities";
import { Limits } from "../src/generated/xr-operator/wire/limits";
import { PublicationSettings } from "../src/generated/xr-operator/wire/publication-settings";

function finish(b: Builder, kind: Message, value: number) {
  Packet.finishPacketBuffer(b, Packet.createPacket(b, kind, value));
  return new Uint8Array(b.asUint8Array());
}
function hello(
  selected = 1,
  versions = [1],
  low = 2n ** 63n + 71n,
  high = 2n ** 60n,
  reason = "",
) {
  const b = new Builder(128);
  const supported = ServerHello.createSupportedVersionsVector(b, versions);
  const detail = reason ? b.createString(reason) : 0;
  ServerHello.startServerHello(b);
  ServerHello.addRequestId(b, 2n ** 63n + 5n);
  ServerHello.addSelectedVersion(b, selected);
  ServerHello.addSupportedVersions(b, supported);
  if (detail) ServerHello.addReason(b, detail);
  if (selected)
    ServerHello.addServerSessionId(b, SessionId.createSessionId(b, low, high));
  return finish(b, Message.ServerHello, ServerHello.endServerHello(b));
}

test("hello preserves all 64-bit values and writes XROP framing", () => {
  const sent = Packet.getRootAsPacket(
    new ByteBuffer(encode("ClientHello", 2n ** 64n - 1n)),
  );
  assert.equal(sent.messageType(), Message.ClientHello);
  const client = sent.message(new ClientHello()) as ClientHello;
  assert.equal(client.requestId(), 2n ** 64n - 1n);
  assert.equal(client.supportedVersions(0), 1);
  const response = decode(hello(), "control");
  assert.equal(response.kind, "ServerHello");
  if (response.kind !== "ServerHello") throw new Error("Expected hello");
  assert.equal(response.requestId, 2n ** 63n + 5n);
  assert.deepEqual(response.session, { low: 2n ** 63n + 71n, high: 2n ** 60n });
});

test("reject malformed, oversized, wrong-channel and semantically invalid messages", () => {
  const good = hello();
  for (let length = 0; length < good.length; length++)
    assert.throws(() => decode(good.subarray(0, length), "control"));
  for (const offset of [0, 4]) {
    const bad = good.slice();
    bad[offset] = 255;
    assert.throws(() => decode(bad, "control"));
  }
  assert.throws(() => decode(new Uint8Array(MAX_PACKET + 1), "control"));
  assert.throws(() => decode(good, "tracking"));
  assert.throws(() => decode(encode("ClientHello", 1n), "control"));
  assert.throws(() => decode(hello(1, [1, 1]), "control"));
  assert.throws(() => decode(hello(1, [1], 0n, 0n), "control"));
  assert.throws(() => decode(hello(1, [2]), "control"));
  assert.throws(() => decode(hello(0), "control"));
  const rejection = decode(
    hello(0, [1], 0n, 0n, "No common version"),
    "control",
  );
  assert.equal(rejection.kind, "ServerHello");
  assert.throws(() => encode("ClockProbe", 0n));
});

test("empty discovery reports absence, validates limits and defaults", () => {
  function capabilities(maxControl = MAX_PACKET, rate = 1) {
    const b = new Builder(256);
    const spaces = Capabilities.createReferenceSpacesVector(b, []);
    const publication = PublicationSettings.createPublicationSettings(
      b,
      rate,
      1,
    );
    const limits = Limits.createLimits(b, 1, 120, 1, MAX_PACKET, maxControl, 1);
    Capabilities.startCapabilities(b);
    Capabilities.addReferenceSpaces(b, spaces);
    Capabilities.addPublicationDefaults(b, publication);
    Capabilities.addLimits(b, limits);
    return finish(b, Message.Capabilities, Capabilities.endCapabilities(b));
  }
  const result = decode(capabilities(), "control");
  assert.equal(result.kind, "Capabilities");
  if (result.kind !== "Capabilities") throw new Error("Expected capabilities");
  assert.equal(result.pose, false);
  assert.equal(result.controller, false);
  assert.equal(result.body, false);
  assert.equal(result.limits.maxControlMessageBytes, MAX_PACKET);
  assert.throws(() => decode(capabilities(MAX_PACKET + 1), "control"));
  assert.throws(() => decode(capabilities(MAX_PACKET, NaN), "control"));
  assert.throws(() => decode(capabilities(MAX_PACKET, 0), "control"));
});

test("clock replies support zero and signed nanoseconds", () => {
  const b = new Builder(128);
  const packet = finish(
    b,
    Message.ClockReply,
    ClockReply.createClockReply(b, 2n ** 63n, 0n, 17n),
  );
  assert.deepEqual(decode(packet, "tracking"), {
    kind: "ClockReply",
    requestId: 2n ** 63n,
    receivedAt: 0n,
    sentAt: 17n,
  });
  assert.throws(() => decode(packet, "control"));
});
