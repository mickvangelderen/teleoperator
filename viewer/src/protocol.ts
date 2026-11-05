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
  controller: false;
  pose: false | { sources: string[] };
  body: false;
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
export type Reference = { kind: "ReferenceSpaceDefinition"; id: bigint; version: number };
export type Accepted = { kind: "StreamAccepted"; requestId: bigint; streamId: bigint; subscriptionId: bigint; sources: string[]; reference: { id: bigint; version: number }; rate: number; history: number };
export type Pose = { position: number[]; orientation: number[]; flags: number; active: boolean | null };
export type Sample = { number: bigint; acquiredAt: bigint; targetAt: bigint | null; referenceVersion: number; poses: Pose[] };
export type Tracking = { kind: "Tracking"; streamId: bigint; subscriptionId: bigint; messageNumber: bigint; samples: Sample[] };
export type Received = Hello | Capabilities | ClockReply | Reference | Accepted | Tracking
  | { kind: "RequestRejected"; requestId: bigint; reason: string }
  | { kind: "StreamClosed"; streamId: bigint; requestId: bigint }
  | { kind: "SubscriptionRetired"; subscriptionId: bigint }
  | { kind: "ServerResumed" };

export function subscribe(id: bigint, sources: string[], rate = 100, history = 1, streamId = 0n): Uint8Array<ArrayBuffer> {
  const b = new Builder(512);
  const selections = sources.map(s => PoseSelection.createPoseSelection(b, b.createString(s), Requirement.Required, Requirement.Omit));
  const vector = PoseSettings.createSourcesVector(b, selections);
  PoseSettings.startPoseSettings(b);
  PoseSettings.addSampleRateHz(b, 100); PoseSettings.addSources(b, vector); PoseSettings.addBaseSpaceId(b, 1n);
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
export function unsubscribe(id: bigint, streamId: bigint): Uint8Array<ArrayBuffer> {
  const b = new Builder(128);
  const request = Unsubscribe.createUnsubscribe(b, id, streamId);
  Packet.finishPacketBuffer(b, Packet.createPacket(b, Message.Unsubscribe, request));
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
    const floats = Array.from({length: 7}, (_, i) => this.view.getFloat32(field + 4 * i, true));
    const flags = this.view.getUint16(field + 28, true);
    requireValue(flags <= 15);
    if (flags & 2) requireValue(floats.slice(0, 3).every(Number.isFinite));
    if (flags & 1) requireValue(floats.slice(3).every(Number.isFinite) && Math.abs(Math.hypot(...floats.slice(3)) - 1) < 0.02);
    const active = this.number(1, "u8"); requireValue(active <= 1 && !this.field(2, 4));
    return { position: floats.slice(0, 3), orientation: floats.slice(3), flags, active: this.field(1, 1) ? !!active : null };
  }
}

function reference(table: Table): Reference {
  requireValue(table.number(1, "u8") <= 4);
  return { kind: "ReferenceSpaceDefinition", ...table.metadata(0) };
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
      requireValue(message.number(3, "u8") === 2);
      const samples: Sample[] = message.child(4).tables(0, 8).map(s => ({ number: s.integer(0), acquiredAt: s.integer(1, true), targetAt: s.field(2, 8) ? s.integer(2, true) : null, referenceVersion: s.number(3, "u32"), poses: s.tables(4, 64).map(p => p.pose()) }));
      requireValue(samples.length > 0);
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]; requireValue(s.number > 0n && s.referenceVersion > 0 && s.poses.length > 0);
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
  if (kind === Message.StreamAccepted) {
    const d = message.child(2), p = message.child(3);
    requireValue(d.number(1, "u8") === 2);
    const names = sources(d, 4), settings = d.child(2);
    requireValue(JSON.stringify(names) === JSON.stringify(sources(settings, 1)));
    const result: Accepted = { kind: "StreamAccepted", requestId: message.integer(0), streamId: message.integer(1), subscriptionId: d.integer(0), sources: names, reference: d.metadata(5), rate: p.number(0, "f32"), history: p.number(1, "u32", 1) };
    requireValue(result.streamId > 0n && result.subscriptionId > 0n && Number.isFinite(result.rate) && result.rate >= 1 && result.rate <= 100 && result.history >= 1 && result.history <= 8 && settings.integer(2) === result.reference.id);
    message.tables(4, 64);
    return result;
  }
  requireValue(kind === Message.Capabilities, "Unexpected control message");
  for (const index of [0, 2])
    requireValue(
      !message.field(index, 4),
      "This Viewer does not yet support tracking capabilities",
    );
  const defaults = message.child(4),
    limits = message.child(5);
  const result: Capabilities = {
    kind: "Capabilities",
    controller: false,
    pose: message.field(1, 4) ? { sources: sources(message.child(1), 0) } : false,
    body: false,
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
