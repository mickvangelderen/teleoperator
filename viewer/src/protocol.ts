import { Builder } from "flatbuffers";
import { ClientHello } from "./generated/xr-operator/wire/client-hello";
import { ClockProbe } from "./generated/xr-operator/wire/clock-probe";
import { Packet } from "./generated/xr-operator/wire/packet";
import { Message } from "./generated/xr-operator/wire/message";

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
  pose: false;
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
};
export type ClockReply = {
  kind: "ClockReply";
  requestId: bigint;
  receivedAt: bigint;
  sentAt: bigint;
};
export type Received = Hello | Capabilities | ClockReply;

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
  requireValue(kind === Message.Capabilities, "Unexpected control message");
  // This milestone deliberately accepts only the implemented, empty discovery snapshot.
  for (const index of [0, 1, 2])
    requireValue(
      !message.field(index, 4),
      "This Viewer does not yet support tracking capabilities",
    );
  message.vector(3, 0);
  const defaults = message.child(4),
    limits = message.child(5);
  const result: Capabilities = {
    kind: "Capabilities",
    controller: false,
    pose: false,
    body: false,
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
