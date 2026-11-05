import assert from "node:assert/strict";
import { test } from "node:test";
import { Builder, ByteBuffer } from "flatbuffers";
import { decode, encode, MAX_PACKET, subscribe, subscribeInputs, subscribeBody } from "../src/protocol";
import { Packet } from "../src/generated/xr-operator/wire/packet";
import { Message } from "../src/generated/xr-operator/wire/message";
import { ClientHello } from "../src/generated/xr-operator/wire/client-hello";
import { ServerHello } from "../src/generated/xr-operator/wire/server-hello";
import { SessionId } from "../src/generated/xr-operator/wire/session-id";
import { ClockReply } from "../src/generated/xr-operator/wire/clock-reply";
import { Capabilities } from "../src/generated/xr-operator/wire/capabilities";
import { Limits } from "../src/generated/xr-operator/wire/limits";
import { PublicationSettings } from "../src/generated/xr-operator/wire/publication-settings";
import { PoseValue } from "../src/generated/xr-operator/wire/pose-value";
import { PoseSample } from "../src/generated/xr-operator/wire/pose-sample";
import { PoseSamples } from "../src/generated/xr-operator/wire/pose-samples";
import { Tracking } from "../src/generated/xr-operator/wire/tracking";
import { JointPose } from "../src/generated/xr-operator/wire/joint-pose";
import { Samples } from "../src/generated/xr-operator/wire/samples";
import { ControllerValue } from "../src/generated/xr-operator/wire/controller-value";
import { ControllerSample } from "../src/generated/xr-operator/wire/controller-sample";
import { ControllerSamples } from "../src/generated/xr-operator/wire/controller-samples";
import { BooleanValue } from "../src/generated/xr-operator/wire/boolean-value";
import { ScalarValue } from "../src/generated/xr-operator/wire/scalar-value";
import { InputValue } from "../src/generated/xr-operator/wire/input-value";
import { BodySample } from "../src/generated/xr-operator/wire/body-sample";
import { BodySamples } from "../src/generated/xr-operator/wire/body-samples";
import { SkeletonJoint } from "../src/generated/xr-operator/wire/skeleton-joint";
import { SkeletonDefinition } from "../src/generated/xr-operator/wire/skeleton-definition";
import { MetadataRef } from "../src/generated/xr-operator/wire/metadata-ref";
import { Transform } from "../src/generated/xr-operator/wire/transform";
import { LocationFlags } from "../src/generated/xr-operator/wire/location-flags";
import { Subscribe } from "../src/generated/xr-operator/wire/subscribe";
import { PoseSettings } from "../src/generated/xr-operator/wire/pose-settings";
import { ControllerSettings } from "../src/generated/xr-operator/wire/controller-settings";
import { BodySettings } from "../src/generated/xr-operator/wire/body-settings";

function finish(b: Builder, kind: Message, value: number) {
  Packet.finishPacketBuffer(b, Packet.createPacket(b, kind, value));
  return new Uint8Array(b.asUint8Array());
}

test("all subscription requests acquire at 200 Hz and publish at 100 Hz with two samples", () => {
  const cases = [
    [subscribe(1n, ["head"]), new PoseSettings()],
    [subscribeInputs(2n, [{ source: "left", id: "trigger", label: "Trigger", type: 1 }]), new ControllerSettings()],
    [subscribeBody(3n, "body", "default"), new BodySettings()],
  ] as const;
  for (const [bytes, settings] of cases) {
    const packet = Packet.getRootAsPacket(new ByteBuffer(bytes));
    const request = packet.message(new Subscribe()) as Subscribe;
    assert.equal(request.acquisition(settings).sampleRateHz(), 200);
    assert.equal(request.publication()!.sendRateHz(), 100);
    assert.equal(request.publication()!.historyLength(), 2);
  }
});
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

test("tracking validates nested histories and preserves pose validity and optional timestamps", () => {
  function tracking(numbers = [9007199254740993n, 9007199254740994n], flags = 15, x = 0, version = 1) {
    const b = new Builder(512);
    const samples = numbers.map(number => {
      PoseValue.startPoseValue(b);
      PoseValue.addLocation(b, JointPose.createJointPose(b, x, 1.6, 0, 0, 0, 0, 1, flags));
      PoseValue.addIsActive(b, false);
      const pose = PoseValue.endPoseValue(b);
      const poses = PoseSample.createPosesVector(b, [pose]);
      return PoseSample.createPoseSample(b, number, 0n, 0n, version, poses);
    });
    const history = PoseSamples.createPoseSamples(b, PoseSamples.createSamplesVector(b, samples));
    const tracking = Tracking.createTracking(b, 1n, 2n, 3n, Samples.PoseSamples, history);
    return finish(b, Message.Tracking, tracking);
  }
  const data = tracking(), result = decode(data, "tracking");
  assert.equal(result.kind, "Tracking");
  if (result.kind !== "Tracking") throw new Error("Expected tracking");
  assert.equal(result.samples[0].number, 9007199254740993n);
  assert.equal(result.samples[0].targetAt, 0n);
  assert.equal(result.samples[0].poses[0].active, false);
  for (let end = 0; end < data.length; end++) assert.throws(() => decode(data.subarray(0, end), "tracking"));
  assert.throws(() => decode(data, "control"));
  assert.throws(() => decode(tracking([1n, 3n]), "tracking"));
  assert.throws(() => decode(tracking([], 0), "tracking"));
  assert.throws(() => decode(tracking([1n], 15, NaN), "tracking"));
  assert.throws(() => decode(tracking([1n], 15, 0, 0), "tracking"));
  assert.doesNotThrow(() => decode(tracking([1n], 0, NaN), "tracking"));
});

test("controller snapshots preserve cumulative counters and reject invalid active analog values", () => {
  function snapshot(scalar = 0.5) {
    const b = new Builder(512);
    const bool = BooleanValue.createBooleanValue(b, false, 9007199254740993n, 9007199254740993n);
    const boolInput = ControllerValue.createControllerValue(b, true, 0n, InputValue.BooleanValue, bool);
    const analog = ScalarValue.createScalarValue(b, scalar);
    const analogInput = ControllerValue.createControllerValue(b, true, null, InputValue.ScalarValue, analog);
    const sample = ControllerSample.createControllerSample(b, 1n, 0n, ControllerSample.createValuesVector(b, [boolInput, analogInput]));
    const history = ControllerSamples.createControllerSamples(b, ControllerSamples.createSamplesVector(b, [sample]));
    return finish(b, Message.Tracking, Tracking.createTracking(b, 1n, 2n, 1n, Samples.ControllerSamples, history));
  }
  const data = snapshot(), result = decode(data, "tracking");
  assert.equal(result.kind, "Tracking");
  if (result.kind !== "Tracking") throw new Error("Expected tracking");
  assert.equal(result.samples[0].type, "controller");
  assert.equal(result.samples[0].inputs[0].presses, 9007199254740993n);
  assert.equal(result.samples[0].inputs[0].changedAt, 0n);
  assert.equal(result.samples[0].inputs[1].changedAt, null);
  for (const value of [NaN, Infinity, -0.1, 1.1]) assert.throws(() => decode(snapshot(value), "tracking"));
  for (let end = 0; end < data.length; end++) assert.throws(() => decode(data.subarray(0, end), "tracking"));
});

test("body packets retain metadata versions, quality and fixed-size joint geometry", () => {
  function snapshot(confidence = 0.75, fidelity = 2) {
    const b = new Builder(512);
    BodySample.startJointsVector(b, 1); JointPose.createJointPose(b, 1, 2, 3, 0, 0, 0, 1, LocationFlags.OrientationValid | LocationFlags.PositionValid | LocationFlags.OrientationTracked | LocationFlags.PositionTracked); const joints = b.endVector();
    const sample = BodySample.createBodySample(b, 99n, 123n, 0n, 0n, 4, 7, true, confidence, fidelity, 1, joints);
    const history = BodySamples.createBodySamples(b, BodySamples.createSamplesVector(b, [sample]));
    return finish(b, Message.Tracking, Tracking.createTracking(b, 1n, 2n, 3n, Samples.BodySamples, history));
  }
  const result = decode(snapshot(), "tracking"); assert.equal(result.kind, "Tracking");
  if (result.kind !== "Tracking") throw new Error("Expected tracking");
  assert.deepEqual(result.samples[0].poses[0].position, [1, 2, 3]);
  assert.equal(result.samples[0].referenceVersion, 4);
  assert.deepEqual(result.samples[0].body, { active: true, confidence: 0.75, returnedAt: 0n, skeletonVersion: 7, fidelity: 2, calibration: 1 });
  for (const confidence of [NaN, -1, 2]) assert.throws(() => decode(snapshot(confidence), "tracking"));
  assert.throws(() => decode(snapshot(0.5, 0), "tracking"));
});

test("skeleton metadata rejects cycles and missing parents", () => {
  function skeleton(parents = [-1, 0]) {
    const b = new Builder(512);
    const joints = parents.map((parent, id) => {
      const name = b.createString(`joint ${id}`);
      SkeletonJoint.startSkeletonJoint(b); SkeletonJoint.addJointId(b, id); SkeletonJoint.addParentId(b, parent); SkeletonJoint.addName(b, name); SkeletonJoint.addRestPose(b, Transform.createTransform(b, 0, id, 0, 0, 0, 0, 1)); return SkeletonJoint.endSkeletonJoint(b);
    });
    const vector = SkeletonDefinition.createJointsVector(b, joints), set = b.createString("test");
    SkeletonDefinition.startSkeletonDefinition(b); SkeletonDefinition.addJoints(b, vector); SkeletonDefinition.addJointSet(b, set); SkeletonDefinition.addReference(b, MetadataRef.createMetadataRef(b, 2n, 1)); SkeletonDefinition.addReferenceSpace(b, MetadataRef.createMetadataRef(b, 1n, 3));
    return finish(b, Message.SkeletonDefinition, SkeletonDefinition.endSkeletonDefinition(b));
  }
  assert.equal(decode(skeleton(), "control").kind, "SkeletonDefinition");
  assert.throws(() => decode(skeleton([1, 0]), "control"));
  assert.throws(() => decode(skeleton([-1, 10]), "control"));
  assert.throws(() => decode(skeleton(), "tracking"));
});
