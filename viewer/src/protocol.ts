import { Builder } from "flatbuffers";
import { ClientHello } from "./generated/xr-operator/wire/client-hello";
import { ClockProbe } from "./generated/xr-operator/wire/clock-probe";
import { Packet } from "./generated/xr-operator/wire/packet";
import { Message } from "./generated/xr-operator/wire/message";
import { Subscribe } from "./generated/xr-operator/wire/subscribe";
import { PoseSettings } from "./generated/xr-operator/wire/pose-settings";
import { PoseSelection } from "./generated/xr-operator/wire/pose-selection";
import { PublicationSettings } from "./generated/xr-operator/wire/publication-settings";
import { UpdatePublication } from "./generated/xr-operator/wire/update-publication";
import { Unsubscribe } from "./generated/xr-operator/wire/unsubscribe";
import { Acquisition } from "./generated/xr-operator/wire/acquisition";
import { Requirement } from "./generated/xr-operator/wire/requirement";
import { ControllerSettings } from "./generated/xr-operator/wire/controller-settings";
import { ControlSelection } from "./generated/xr-operator/wire/control-selection";
import { BodySettings } from "./generated/xr-operator/wire/body-settings";

export const MAX_PACKET = 65_536;
export type Hello = {
  kind: "ServerHello";
  requestId: bigint;
  selectedVersion: number;
  supportedVersions: number[];
  reason: string;
  session: { low: bigint; high: bigint } | null;
};
export type Capabilities = {
  kind: "Capabilities";
  controller: false | { inputs: InputDefinition[] };
  pose: false | { sources: string[] };
  body: false | { source: string; jointSet: string };
  limits: {
    minSendRateHz: number;
    maxSendRateHz: number;
    maxHistoryLength: number;
    maxTrackingMessageBytes: number;
    maxControlMessageBytes: number;
    maxStreamsPerClient: number;
  };
  publication: { sendRateHz: number; historyLength: number };
  spaces: Reference[];
};
export type ClockReply = {
  kind: "ClockReply";
  requestId: bigint;
  receivedAt: bigint;
  sentAt: bigint;
};
export type Reference = { kind: "ReferenceSpaceDefinition"; id: bigint; version: number; spaceKind: number; effectiveAt: bigint | null; previous: {id: bigint; version: number} | null; poseInPrevious: Pose | null };
export type InputDefinition = { source: string; id: string; type: number; label: string };
export type Input = { active: boolean; changedAt: bigint | null; type: number; value: boolean | number | number[]; presses: bigint; releases: bigint };
export type Accepted = { kind: "StreamAccepted"; type: "pose" | "controller" | "body"; requestId: bigint; streamId: bigint; subscriptionId: bigint; sources: string[]; inputs: InputDefinition[]; reference: { id: bigint; version: number } | null; skeleton: {id: bigint; version: number} | null; jointSet: string | null; sampleRate: number; rate: number; history: number };
export type Pose = { position: number[]; orientation: number[]; flags: number; active: boolean | null };
export type Body = { active: boolean; confidence: number | null; returnedAt: bigint | null; skeletonVersion: number; fidelity: number | null; calibration: number | null };
export type Sample = { type: "pose" | "controller" | "body"; number: bigint; acquiredAt: bigint; targetAt: bigint | null; referenceVersion: number; poses: Pose[]; inputs: Input[]; body: Body | null };
export type Skeleton = { kind: "SkeletonDefinition"; id: bigint; version: number; reference: {id: bigint; version: number}; jointSet: string; joints: {id: number; parent: number; name: string; rest: Pose}[] };
export type Tracking = { kind: "Tracking"; streamId: bigint; subscriptionId: bigint; messageNumber: bigint; samples: Sample[] };
export type Received = Hello | Capabilities | ClockReply | Reference | Accepted | Tracking | Skeleton
  | { kind: "RequestRejected"; requestId: bigint; reason: string }
  | { kind: "StreamClosed"; streamId: bigint; requestId: bigint }
  | { kind: "SubscriptionRetired"; subscriptionId: bigint }
  | { kind: "ServerResumed" };

const SAMPLE_RATE = 200;
export const DEFAULT_SEND_RATE = 100;
export const DEFAULT_HISTORY = 2;

export function subscribe(id: bigint, sources: string[], rate = DEFAULT_SEND_RATE, history = DEFAULT_HISTORY, streamId = 0n): Uint8Array<ArrayBuffer> {
  const b = new Builder(512);
  const selections = sources.map(s => PoseSelection.createPoseSelection(b, b.createString(s), Requirement.Required, Requirement.Omit));
  const vector = PoseSettings.createSourcesVector(b, selections);
  PoseSettings.startPoseSettings(b);
  PoseSettings.addSampleRateHz(b, SAMPLE_RATE); PoseSettings.addSources(b, vector); PoseSettings.addBaseSpaceId(b, 1n);
  const settings = PoseSettings.endPoseSettings(b);
  const publication = PublicationSettings.createPublicationSettings(b, rate, history);
  Subscribe.startSubscribe(b);
  Subscribe.addRequestId(b, id); Subscribe.addStreamId(b, streamId); Subscribe.addAcquisitionType(b, Acquisition.PoseSettings); Subscribe.addAcquisition(b, settings); Subscribe.addPublication(b, publication);
  const request = Subscribe.endSubscribe(b);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.Subscribe, request));
  return new Uint8Array(b.asUint8Array());
}
export function updatePublication(id: bigint, streamId: bigint, rate: number, history: number): Uint8Array<ArrayBuffer> {
  const b = new Builder(128);
  const p = PublicationSettings.createPublicationSettings(b, rate, history);
  UpdatePublication.startUpdatePublication(b); UpdatePublication.addRequestId(b, id); UpdatePublication.addStreamId(b, streamId); UpdatePublication.addPublication(b, p);
  const request = UpdatePublication.endUpdatePublication(b);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.UpdatePublication, request));
  return new Uint8Array(b.asUint8Array());
}
export function subscribeInputs(id: bigint, inputs: InputDefinition[]): Uint8Array<ArrayBuffer> {
  const b = new Builder(2048);
  const selections = inputs.map(input => {
    const source = b.createString(input.source), name = b.createString(input.id);
    ControlSelection.startControlSelection(b); ControlSelection.addSourceId(b, source); ControlSelection.addInputId(b, name);
    return ControlSelection.endControlSelection(b);
  });
  const vector = ControllerSettings.createInputsVector(b, selections);
  ControllerSettings.startControllerSettings(b); ControllerSettings.addSampleRateHz(b, SAMPLE_RATE); ControllerSettings.addInputs(b, vector);
  const settings = ControllerSettings.endControllerSettings(b);
  const publication = PublicationSettings.createPublicationSettings(b, DEFAULT_SEND_RATE, DEFAULT_HISTORY);
  Subscribe.startSubscribe(b); Subscribe.addRequestId(b, id); Subscribe.addAcquisitionType(b, Acquisition.ControllerSettings); Subscribe.addAcquisition(b, settings); Subscribe.addPublication(b, publication);
  const request = Subscribe.endSubscribe(b);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.Subscribe, request));
  return new Uint8Array(b.asUint8Array());
}
export function unsubscribe(id: bigint, streamId: bigint): Uint8Array<ArrayBuffer> {
  const b = new Builder(128);
  const request = Unsubscribe.createUnsubscribe(b, id, streamId);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.Unsubscribe, request));
  return new Uint8Array(b.asUint8Array());
}
export function subscribeBody(id: bigint, source: string, jointSet: string): Uint8Array<ArrayBuffer> {
  const b = new Builder(256), sourceOffset = b.createString(source), set = b.createString(jointSet);
  BodySettings.startBodySettings(b); BodySettings.addSourceId(b, sourceOffset); BodySettings.addJointSet(b, set); BodySettings.addBaseSpaceId(b, 1n); BodySettings.addSampleRateHz(b, SAMPLE_RATE);
  const settings = BodySettings.endBodySettings(b);
  const publication = PublicationSettings.createPublicationSettings(b, DEFAULT_SEND_RATE, DEFAULT_HISTORY);
  Subscribe.startSubscribe(b); Subscribe.addRequestId(b, id); Subscribe.addAcquisitionType(b, Acquisition.BodySettings); Subscribe.addAcquisition(b, settings); Subscribe.addPublication(b, publication);
  const request = Subscribe.endSubscribe(b);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.Subscribe, request));
  return new Uint8Array(b.asUint8Array());
}

export function encode(
  kind: "ClientHello" | "ClockProbe",
  id: bigint,
  versions = [1],
): Uint8Array<ArrayBuffer> {
  if (id <= 0n || id > 0xffffffffffffffffn)
    throw new Error("Invalid request ID");
  const builder = new Builder(128);
  const payload =
    kind === "ClientHello"
      ? ClientHello.createClientHello(
          builder,
          id,
          ClientHello.createSupportedVersionsVector(builder, versions),
        )
      : ClockProbe.createClockProbe(builder, id);
  Packet.finishPacketBuffer(
    builder,
    Packet.createPacket(builder, Message[kind], payload),
  );
  return new Uint8Array(builder.asUint8Array());
}

function requireValue(
  condition: unknown,
  message = "Malformed protocol packet",
): asserts condition {
  if (!condition) throw new Error(message);
}

// Generated TS accessors do not verify buffers. Bounds-check every consumed field first.
class Table {
  private readonly view: DataView;
  private readonly vtable: number;
  private readonly vsize: number;
  private readonly size: number;
  constructor(
    private readonly data: Uint8Array,
    private readonly offset: number,
  ) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.range(offset, 4);
    this.vtable = offset - this.view.getInt32(offset, true);
    requireValue(this.vtable !== offset);
    this.range(this.vtable, 4);
    this.vsize = this.view.getUint16(this.vtable, true);
    this.size = this.view.getUint16(this.vtable + 2, true);
    requireValue(this.vsize >= 4 && this.vsize % 2 === 0 && this.size >= 4);
    this.range(this.vtable, this.vsize);
    this.range(offset, this.size);
  }
  private range(offset: number, length: number) {
    requireValue(
      Number.isSafeInteger(offset) &&
        offset >= 8 &&
        length >= 0 &&
        offset + length <= this.data.length,
    );
  }
  field(index: number, size: number, required = false): number {
    const slot = 4 + index * 2;
    const relative =
      slot < this.vsize ? this.view.getUint16(this.vtable + slot, true) : 0;
    if (!relative) {
      requireValue(!required, "Missing required field");
      return 0;
    }
    requireValue(relative >= 4 && relative + size <= this.size);
    return this.offset + relative;
  }
  private indirect(index: number): number {
    const field = this.field(index, 4, true);
    const relative = this.view.getUint32(field, true);
    requireValue(relative >= 4);
    const target = field + relative;
    this.range(target, 4);
    return target;
  }
  child(index: number) {
    return new Table(this.data, this.indirect(index));
  }
  number(index: number, type: "u8" | "u32" | "f32", fallback = 0): number {
    const field = this.field(index, type === "u8" ? 1 : 4);
    if (!field) return fallback;
    return type === "u8"
      ? this.view.getUint8(field)
      : type === "u32"
        ? this.view.getUint32(field, true)
        : this.view.getFloat32(field, true);
  }
  integer(index: number, signed = false): bigint {
    const field = this.field(index, 8);
    return field
      ? signed
        ? this.view.getBigInt64(field, true)
        : this.view.getBigUint64(field, true)
      : 0n;
  }
  session(index: number) {
    const field = this.field(index, 16);
    return field
      ? {
          low: this.view.getBigUint64(field, true),
          high: this.view.getBigUint64(field + 8, true),
        }
      : null;
  }
  vector(index: number, max: number): number[] {
    const target = this.indirect(index);
    const length = this.view.getUint32(target, true);
    requireValue(length <= max, "Vector exceeds implementation limit");
    this.range(target + 4, length * 4);
    return Array.from({ length }, (_, i) =>
      this.view.getUint32(target + 4 + i * 4, true),
    );
  }
  string(index: number): string {
    if (!this.field(index, 4)) return "";
    const target = this.indirect(index);
    const length = this.view.getUint32(target, true);
    requireValue(length <= 2048);
    this.range(target + 4, length + 1);
    requireValue(this.view.getUint8(target + 4 + length) === 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(
      this.data.subarray(target + 4, target + 4 + length),
    );
  }
  tables(index: number, max: number): Table[] {
    const target = this.indirect(index), length = this.view.getUint32(target, true);
    requireValue(length <= max);
    this.range(target + 4, length * 4);
    return Array.from({ length }, (_, i) => {
      const slot = target + 4 + i * 4, relative = this.view.getUint32(slot, true);
      requireValue(relative >= 4);
      return new Table(this.data, slot + relative);
    });
  }
  metadata(index: number) {
    const field = this.field(index, 16, true);
    const result = { id: this.view.getBigUint64(field, true), version: this.view.getUint32(field + 8, true) };
    requireValue(result.id > 0n && result.version > 0);
    return result;
  }
  pose(): Pose {
    const field = this.field(0, 32, true);
    const result = this.location(field);
    const active = this.number(1, "u8"); requireValue(active <= 1 && !this.field(2, 4));
    return { ...result, active: this.field(1, 1) ? !!active : null };
  }
  private location(field: number, transform = false): Pose {
    this.range(field, transform ? 28 : 32);
    const floats = Array.from({length: 7}, (_, i) => this.view.getFloat32(field + 4 * i, true));
    const flags = transform ? 15 : this.view.getUint16(field + 28, true);
    requireValue(flags <= 15);
    if (flags & 2) requireValue(floats.slice(0, 3).every(Number.isFinite));
    if (flags & 1) requireValue(floats.slice(3).every(Number.isFinite) && Math.abs(Math.hypot(...floats.slice(3)) - 1) < 0.02);
    return { position: floats.slice(0, 3), orientation: floats.slice(3), flags, active: null };
  }
  transform(index: number) { return this.location(this.field(index, 28, true), true); }
  joints(index: number) {
    const target = this.indirect(index), length = this.view.getUint32(target, true);
    requireValue(length > 0 && length <= 84); this.range(target + 4, length * 32);
    return Array.from({ length }, (_, i) => this.location(target + 4 + i * 32));
  }
  vec2(index: number): number[] {
    const field = this.field(index, 8, true);
    return [this.view.getFloat32(field, true), this.view.getFloat32(field + 4, true)];
  }
}

function inputDefinition(t: Table): InputDefinition {
  const result = { source: t.string(0), id: t.string(1), type: t.number(3, "u8"), label: t.string(8) || t.string(4) };
  requireValue(result.source.length > 0 && result.id.length > 0 && result.type <= 2);
  return result;
}
function input(t: Table): Input {
  const kind = t.number(2, "u8"), v = t.child(3), active = t.number(0, "u8");
  requireValue(active <= 1 && kind >= 1 && kind <= 3);
  const value = kind === 1 ? !!v.number(0, "u8") : kind === 2 ? v.number(0, "f32") : v.vec2(0);
  if (kind === 1) requireValue(v.number(0, "u8") <= 1);
  else if (active) requireValue((Array.isArray(value) ? value : [value]).every(n => typeof n === "number" && Number.isFinite(n) && n >= (kind === 2 ? 0 : -1) && n <= 1));
  return { active: !!active, changedAt: t.field(1, 8) ? t.integer(1, true) : null, type: kind - 1, value, presses: kind === 1 ? v.integer(1) : 0n, releases: kind === 1 ? v.integer(2) : 0n };
}

function reference(table: Table): Reference {
  requireValue(table.number(1, "u8") <= 4);
  const previous = table.field(3, 16) ? table.metadata(3) : null;
  const poseInPrevious = table.field(4, 28) ? table.transform(4) : null;
  requireValue(!poseInPrevious || previous);
  return { kind: "ReferenceSpaceDefinition", ...table.metadata(0), spaceKind: table.number(1, "u8"), effectiveAt: table.field(2, 8) ? table.integer(2, true) : null, previous, poseInPrevious };
}
function sources(table: Table, field: number): string[] {
  const result = table.tables(field, 64).map(s => s.string(0));
  requireValue(result.length > 0 && result.every(s => s.length > 0 && s.length <= 256) && new Set(result).size === result.length);
  return result;
}

export function decode(
  data: Uint8Array,
  channel: "control" | "tracking",
): Received {
  requireValue(
    data.length >= 12 && data.length <= MAX_PACKET,
    "Invalid packet size",
  );
  requireValue(
    data[4] === 88 && data[5] === 82 && data[6] === 79 && data[7] === 80,
    "Missing XROP identifier",
  );
  const root = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(0, true);
  const packet = new Table(data, root);
  const kind = packet.number(0, "u8");
  const message = packet.child(1);
  if (channel === "tracking") {
    if (kind === Message.Tracking) {
      const type = message.number(3, "u8"); requireValue(type >= 1 && type <= 3);
      const samples: Sample[] = message.child(4).tables(0, 8).map(s => {
        const base = { number: s.integer(0), acquiredAt: s.integer(1, true) };
        if (type === 1) return { ...base, type: "controller", targetAt: null, referenceVersion: 0, poses: [], inputs: s.tables(2, 128).map(input), body: null };
        const targetAt = s.field(2, 8) ? s.integer(2, true) : null;
        if (type === 2) return { ...base, type: "pose", targetAt, referenceVersion: s.number(3, "u32"), poses: s.tables(4, 64).map(p => p.pose()), inputs: [], body: null };
        const body: Body = { active: !!s.number(6, "u8"), confidence: s.field(7, 4) ? s.number(7, "f32") : null, returnedAt: s.field(3, 8) ? s.integer(3, true) : null, skeletonVersion: s.number(5, "u32"), fidelity: s.field(8, 1) ? s.number(8, "u8") : null, calibration: s.field(9, 1) ? s.number(9, "u8") : null };
        requireValue(s.number(6, "u8") <= 1 && body.skeletonVersion > 0 && (body.confidence === null || Number.isFinite(body.confidence) && body.confidence >= 0 && body.confidence <= 1) && (body.fidelity === null || [1, 2].includes(body.fidelity)) && (body.calibration === null || body.calibration <= 3));
        return { ...base, type: "body", targetAt, referenceVersion: s.number(4, "u32"), poses: s.joints(10), inputs: [], body };
      });
      requireValue(samples.length > 0);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]; requireValue(s.number > 0n && (s.type !== "controller" ? s.referenceVersion > 0 && s.poses.length > 0 : s.inputs.length > 0));
        if (i) requireValue(s.number === samples[i - 1].number + 1n && s.acquiredAt >= samples[i - 1].acquiredAt);
      }
      const result: Tracking = { kind: "Tracking", streamId: message.integer(0), subscriptionId: message.integer(1), messageNumber: message.integer(2), samples };
      requireValue(result.streamId > 0n && result.subscriptionId > 0n && result.messageNumber > 0n);
      return result;
    }
    requireValue(kind === Message.ClockReply, "Unexpected tracking message");
    const reply: ClockReply = {
      kind: "ClockReply",
      requestId: message.integer(0),
      receivedAt: message.integer(1, true),
      sentAt: message.integer(2, true),
    };
    requireValue(
      reply.requestId !== 0n && reply.sentAt >= reply.receivedAt,
      "Invalid clock reply",
    );
    return reply;
  }
  if (kind === Message.ServerHello) {
    const hello: Hello = {
      kind: "ServerHello",
      requestId: message.integer(0),
      selectedVersion: message.number(1, "u32"),
      supportedVersions: message.vector(2, 32),
      reason: message.string(3),
      session: message.session(4),
    };
    requireValue(hello.requestId !== 0n && hello.supportedVersions.length > 0);
    requireValue(
      new Set(hello.supportedVersions).size ===
        hello.supportedVersions.length && !hello.supportedVersions.includes(0),
    );
    if (hello.selectedVersion === 0)
      requireValue(
        hello.reason.length > 0 && hello.session === null,
        "Invalid hello rejection",
      );
    else
      requireValue(
        hello.supportedVersions.includes(hello.selectedVersion) &&
          hello.session &&
          (hello.session.low !== 0n || hello.session.high !== 0n),
        "Invalid session or version",
      );
    return hello;
  }
  if (kind === Message.ReferenceSpaceDefinition) return reference(message);
  if (kind === Message.ServerResumed) return { kind: "ServerResumed" };
  if (kind === Message.SubscriptionRetired) return { kind: "SubscriptionRetired", subscriptionId: message.integer(0) };
  if (kind === Message.RequestRejected) return { kind: "RequestRejected", requestId: message.integer(0), reason: message.string(2) };
  if (kind === Message.StreamClosed) return { kind: "StreamClosed", requestId: message.integer(0), streamId: message.integer(1) };
  if (kind === Message.SkeletonDefinition) {
    const result: Skeleton = { kind: "SkeletonDefinition", ...message.metadata(0), jointSet: message.string(1), reference: message.metadata(2), joints: message.tables(3, 84).map(j => ({ id: j.number(0, "u32"), parent: j.number(1, "u32", 0xffffffff) | 0, name: j.string(2), rest: j.transform(3) })) };
    const parents = new Map(result.joints.map(j => [j.id, j.parent]));
    requireValue(result.joints.length > 0 && parents.size === result.joints.length && result.jointSet.length > 0);
    for (const joint of result.joints) {
      requireValue(joint.id <= 0x7fffffff && joint.name.length > 0 && (joint.parent === -1 || parents.has(joint.parent)));
      let parent = joint.parent; const visited = new Set<number>([joint.id]);
      while (parent !== -1) { requireValue(!visited.has(parent) && parents.has(parent)); visited.add(parent); parent = parents.get(parent)!; }
    }
    return result;
  }
  if (kind === Message.StreamAccepted) {
    const d = message.child(2), p = message.child(3);
    const type = d.number(1, "u8"); requireValue(type >= 1 && type <= 3);
    const definitions = type === 1 ? d.tables(3, 128).map(inputDefinition) : [];
    const settings = d.child(2);
    const names = type === 2 ? sources(d, 4) : type === 3 ? [settings.string(1)] : definitions.map(d => `${d.source}/${d.id}`);
    const selected = type === 2 ? sources(settings, 1) : type === 3 ? names : settings.tables(1, 128).map(s => `${s.string(0)}/${s.string(1)}`);
    requireValue(names.length > 0 && names.every(Boolean) && new Set(names).size === names.length && JSON.stringify(names) === JSON.stringify(selected));
    const result: Accepted = { kind: "StreamAccepted", type: type === 1 ? "controller" : type === 2 ? "pose" : "body", requestId: message.integer(0), streamId: message.integer(1), subscriptionId: d.integer(0), sources: names, inputs: definitions, reference: type !== 1 ? d.metadata(5) : null, skeleton: type === 3 ? d.metadata(6) : null, jointSet: type === 3 ? settings.string(2) : null, sampleRate: settings.number(0, "f32"), rate: p.number(0, "f32"), history: p.number(1, "u32", 1) };
    requireValue(Number.isFinite(result.sampleRate) && result.sampleRate > 0);
    requireValue(result.streamId > 0n && result.subscriptionId > 0n && Number.isFinite(result.rate) && result.rate >= 1 && result.rate <= 200 && result.history >= 1 && result.history <= 8 && (!result.reference || settings.integer(type === 3 ? 3 : 2) === result.reference.id));
    message.tables(4, 64);
    return result;
  }
  requireValue(kind === Message.Capabilities, "Unexpected control message");
  const defaults = message.child(4),
    limits = message.child(5);
  const result: Capabilities = {
    kind: "Capabilities",
    controller: message.field(0, 4) ? { inputs: message.child(0).tables(1, 128).map(inputDefinition) } : false,
    pose: message.field(1, 4) ? { sources: sources(message.child(1), 0) } : false,
    body: message.field(2, 4) ? { source: message.child(2).child(4).string(1), jointSet: message.child(2).child(4).string(2) } : false,
    spaces: message.tables(3, 64).map(reference),
    limits: {
      minSendRateHz: limits.number(0, "f32"),
      maxSendRateHz: limits.number(1, "f32"),
      maxHistoryLength: limits.number(2, "u32"),
      maxTrackingMessageBytes: limits.number(3, "u32"),
      maxControlMessageBytes: limits.number(4, "u32"),
      maxStreamsPerClient: limits.number(5, "u32"),
    },
    publication: {
      sendRateHz: defaults.number(0, "f32"),
      historyLength: defaults.number(1, "u32", 1),
    },
  };
  const l = result.limits,
    p = result.publication;
  requireValue(
    Object.values(l).every((value) => Number.isFinite(value) && value > 0),
  );
  requireValue(
    l.minSendRateHz <= l.maxSendRateHz &&
      l.maxControlMessageBytes <= MAX_PACKET,
  );
  requireValue(
    Number.isFinite(p.sendRateHz) &&
      p.sendRateHz >= l.minSendRateHz &&
      p.sendRateHz <= l.maxSendRateHz &&
      p.historyLength >= 1 &&
      p.historyLength <= l.maxHistoryLength,
  );
  return result;
}

export function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => (typeof item === "bigint" ? item.toString() : item),
    2,
  );
}
