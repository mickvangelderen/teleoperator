// Version 1 wire contract; no device identities or rendering assumptions.
export const MAX_CONTROL = 1_048_576;
export const MAX_PACKET = 16_384;
export const kindNames = ["invalid", "generic", "pressed", "press_count", "release_count", "touched", "touch_count", "untouch_count", "trigger", "thumbstick", "pose", "revision", "position_valid", "orientation_valid", "position_tracked", "orientation_tracked", "confidence"];
export const formatNames = ["invalid", "bit", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64", "unorm8", "unorm16", "snorm8", "snorm16"];
export const spaceNames = ["absent", "view", "local", "stage", "local_floor", "parent"];
export const referenceKinds = { press_count_sample: 3, release_count_sample: 4, touch_count_sample: 6, untouch_count_sample: 7, position_valid_sample: 12, orientation_valid_sample: 13, position_tracked_sample: 14, orientation_tracked_sample: 15, confidence_sample: 16 } as const;
export type ReferenceField = keyof typeof referenceKinds;
export type Descriptor = { id: string; name: string; description: string; kind: number; formats: number[]; group: number; spaces: number[]; revision_of?: number } & Partial<Record<ReferenceField, number | null>>;
export const referenceFields = (kind: number): ReferenceField[] => kind === 2 ? ["press_count_sample", "release_count_sample"] : kind === 5 ? ["touch_count_sample", "untouch_count_sample"] : kind === 10 ? ["position_valid_sample", "orientation_valid_sample", "position_tracked_sample", "orientation_tracked_sample", "confidence_sample"] : [];
export const preferredFormat = (d: Descriptor) => d.kind === 10 && d.formats.includes(10) ? 10 : d.formats.includes(3) ? 3 : d.formats[0];
export type Joint = { parent: number; pose_sample: number; rest_pose_sample: number };
export type Capabilities = { groups: number[]; descriptors: Descriptor[]; skeletons: { joints: Joint[] }[] };
export function restGroup(c: Capabilities, group: number) {
  const rest = new Set(c.skeletons.flatMap(s => s.joints.map(j => j.rest_pose_sample)));
  return c.descriptors.some((d, i) => d.group === group && rest.has(i))
    && c.descriptors.every((d, i) => d.group !== group || rest.has(i) || d.kind === 11);
}
export type Selection = { descriptor: number; format: number; space: number };
export type Request = { id: number; group: number; delivery: number; rate: number; samples: Selection[] };
export type ServerMessage =
  | { tag: 2; version: number } | { tag: 3; capabilities: Capabilities }
  | { tag: 5; id: number; generation: number } | { tag: 6; id: number; reason: string }
  | { tag: 8; id: number; generation: number; reason: string }
  | { tag: 9; body: Uint8Array };
export type Value = boolean | number | bigint | number[];
export type Packet = { id: number; generation: number; timestamp: bigint; values: (Value | null)[] };
export const components = (kind: number) => kind === 9 ? 2 : kind === 10 ? 7 : 1;
export const width = (format: number) => [0, 0, 1, 2, 4, 8, 1, 2, 4, 8, 4, 8, 1, 2, 1, 2][format] ?? 0;
export const counterKind = (kind: number) => [3, 4, 6, 7, 11].includes(kind);
export function compatible(kind: number, format: number): boolean {
  if (kind === 1) return format >= 1 && format <= 15;
  if ([2, 5, 12, 13, 14, 15].includes(kind)) return format === 1;
  if (counterKind(kind)) return format >= 2 && format <= 5;
  if (kind === 8 || kind === 16) return [10, 11, 12, 13].includes(format);
  if (kind === 9) return [10, 11, 14, 15].includes(format);
  return kind === 10 && [10, 11].includes(format);
}
const check = (ok: unknown, reason: string): void => { if (!ok) throw new Error(reason); };
const unique = (items: unknown[]) => new Set(items).size === items.length;
export function validateCapabilities(c: Capabilities) {
  check(c.groups.length <= 128 && c.descriptors.length <= 4096, "Capability resource limit");
  check(c.groups.every(r => Number.isFinite(r) && r > 0), "Invalid group rate");
  check(unique(c.descriptors.map(d => d.id)), "Duplicate sample id");
  for (const d of c.descriptors) {
    check(d.id.length && d.group < c.groups.length, "Invalid sample identity or group");
    check(d.formats.length && unique(d.formats) && d.formats.every(f => compatible(d.kind, f)), "Invalid sample formats");
    check(d.kind === 10 ? d.spaces.length && unique(d.spaces) && d.spaces.every(s => s >= 1 && s <= 5) : d.spaces.length === 0, "Invalid reference spaces");
    for (const field of referenceFields(d.kind)) {
      const index = d[field];
      check(index == null || c.descriptors[index]?.kind === referenceKinds[field], "Invalid descriptor reference");
    }
    if (d.kind === 11) check(Number.isInteger(d.revision_of) && d.revision_of! >= 0 && d.revision_of! < c.groups.length, "Invalid revision group");
  }
  check(c.skeletons.length <= 128, "Skeleton resource limit");
  let joints = 0;
  for (const skeleton of c.skeletons) {
    joints += skeleton.joints.length;
    check(skeleton.joints.length && joints <= 4096, "Joint resource limit");
    for (const joint of skeleton.joints) {
      check(Number.isInteger(joint.parent) && joint.parent >= 0 && joint.parent < skeleton.joints.length && [joint.pose_sample, joint.rest_pose_sample].every(i => c.descriptors[i]?.kind === 10), "Invalid skeleton reference");
    }
  }
}
export function validateRequest(c: Capabilities, r: Request) {
  check(r.delivery === 1 || r.delivery === 2, "Unsupported delivery mode");
  check(Number.isInteger(r.id) && r.id >= 0 && r.id <= 0xffffffff, "Invalid subscription id");
  check(Number.isInteger(r.group) && r.group >= 0 && r.group < c.groups.length, "Unknown group");
  check(Number.isFinite(r.rate) && r.rate > 0 && r.rate <= c.groups[r.group], "Invalid publication rate");
  check(r.samples.length && unique(r.samples.map(s => s.descriptor)), "Empty or duplicate sample selection");
  let size = 16 + Math.ceil(r.samples.length / 8), bits = 0;
  for (const s of r.samples) {
    const d = c.descriptors[s.descriptor];
    check(d && d.group === r.group && d.formats.includes(s.format) && compatible(d.kind, s.format), "Unsupported sample selection");
    check(d.kind === 10 ? d.spaces.includes(s.space) : s.space === 0, "Unsupported reference space");
    if (s.format === 1) bits++; else size += components(d.kind) * width(s.format);
  }
  check(size + Math.ceil(bits / 8) + 1 <= (r.delivery === 1 ? MAX_PACKET : MAX_CONTROL), "Publication too large");
}
class Reader {
  at = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) { this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
  take(n: number) { check(n >= 0 && n <= this.bytes.length - this.at, "Truncated record"); const start = this.at; this.at += n; return start; }
  u8() { return this.view.getUint8(this.take(1)); }
  u16() { return this.view.getUint16(this.take(2), true); }
  u32() { return this.view.getUint32(this.take(4), true); }
  u64() { return this.view.getBigUint64(this.take(8), true); }
  f32() { return this.view.getFloat32(this.take(4), true); }
  count(minimum: number) { const n = this.u32(); check(n <= (this.bytes.length - this.at) / minimum, "Impossible list count"); return n; }
  list<T>(minimum: number, read: () => T) { return Array.from({ length: this.count(minimum) }, read); }
  string() { const n = this.u32(), start = this.take(n); return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(this.bytes.subarray(start, start + n)); }
  done() { check(this.at === this.bytes.length, "Trailing bytes"); }
  bitmap(n: number) {
    const size = Math.ceil(n / 8), start = this.take(size), bytes = this.bytes.subarray(start, start + size);
    if (n % 8) check((bytes[size - 1] >> (n % 8)) === 0, "Nonzero bitmap padding");
    return (i: number) => !!(bytes[i >> 3] & (1 << (i % 8)));
  }
  number(format: number): number | bigint {
    const at = this.take(width(format)), v = this.view;
    switch (format) {
      case 2: return v.getUint8(at); case 3: return v.getUint16(at, true); case 4: return v.getUint32(at, true); case 5: return v.getBigUint64(at, true);
      case 6: return v.getInt8(at); case 7: return v.getInt16(at, true); case 8: return v.getInt32(at, true); case 9: return v.getBigInt64(at, true);
      case 10: return v.getFloat32(at, true); case 11: return v.getFloat64(at, true);
      case 12: return v.getUint8(at) / 255; case 13: return v.getUint16(at, true) / 65535;
      case 14: return Math.max(-1, v.getInt8(at) / 127); case 15: return Math.max(-1, v.getInt16(at, true) / 32767);
      default: throw new Error("Invalid numeric format");
    }
  }
}
function decodeServer(bytes: Uint8Array): ServerMessage {
  const r = new Reader(bytes), tag = r.u8();
  let message: ServerMessage;
  switch (tag) {
    case 2: message = { tag, version: r.u16() }; break;
    case 3: {
      const groups = r.list(4, () => r.f32());
      const descriptors = r.list(18, () => {
        const id = r.string(), name = r.string(), description = r.string(), kind = r.u8();
        check(kind >= 1 && kind <= 16, "Invalid sample kind");
        const formats = r.list(1, () => r.u8()), group = r.u32();
        const d: Descriptor = { id, name, description, kind, formats, group, spaces: kind === 10 ? r.list(1, () => r.u8()) : [] };
        for (const field of referenceFields(kind)) { const index = r.u32(); d[field] = index === 0xffffffff ? null : index; }
        if (kind === 11) d.revision_of = r.u32();
        return d;
      });
      const skeletons = r.list(4, () => ({ joints: r.list(12, () => ({ parent: r.u32(), pose_sample: r.u32(), rest_pose_sample: r.u32() })) }));
      const capabilities = { groups, descriptors, skeletons }; validateCapabilities(capabilities);
      message = { tag, capabilities }; break;
    }
    case 5: message = { tag, id: r.u32(), generation: r.u32() }; break;
    case 6: message = { tag, id: r.u32(), reason: r.string() }; break;
    case 8: message = { tag, id: r.u32(), generation: r.u32(), reason: r.string() }; break;
    case 9: message = { tag, body: bytes.slice(r.at) }; r.take(bytes.length - r.at); break;
    default: throw new Error("Invalid server message tag or direction");
  }
  r.done();
  if (message.tag === 5 || message.tag === 8) check(message.generation !== 0, "Invalid generation");
  if (message.tag === 6 || message.tag === 8) check(message.reason.length > 0, "Missing reason");
  return message;
}
export class ControlDecoder {
  private pending = new Uint8Array(0);
  reset() { this.pending = new Uint8Array(0); }
  feed(bytes: Uint8Array): ServerMessage[] {
    check(this.pending.length + bytes.length <= MAX_CONTROL * 2, "Control buffer limit");
    const joined = new Uint8Array(this.pending.length + bytes.length); joined.set(this.pending); joined.set(bytes, this.pending.length);
    let at = 0;
    const view = new DataView(joined.buffer), result: ServerMessage[] = [];
    while (joined.length - at >= 4) {
      const n = view.getUint32(at, true); check(n > 0 && n <= MAX_CONTROL, "Control record length limit");
      if (joined.length - at < n + 4) break;
      result.push(decodeServer(joined.subarray(at + 4, at + 4 + n))); at += n + 4;
      check(result.length <= 1024, "Too many control records");
    }
    this.pending = joined.slice(at); return result;
  }
}
class Writer {
  bytes: number[] = [0, 0, 0, 0];
  u8(n: number) { this.bytes.push(n); }
  u16(n: number) { this.bytes.push(n & 255, n >>> 8); }
  u32(n: number) { this.bytes.push(n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24); }
  f32(n: number) { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, n, true); this.bytes.push(...new Uint8Array(b)); }
  finish() { const bytes = new Uint8Array(this.bytes); new DataView(bytes.buffer).setUint32(0, bytes.length - 4, true); return bytes; }
}
export function offer() { const w = new Writer(); w.u8(1); w.u32(1); w.u16(1); return w.finish(); }
export function subscribe(r: Request) {
  const w = new Writer(); w.u8(4); w.u32(r.id); w.u32(r.group); w.u8(r.delivery); w.f32(r.rate); w.u32(r.samples.length);
  for (const s of r.samples) { w.u32(s.descriptor); w.u8(s.format); w.u8(s.space); } return w.finish();
}
export function unsubscribe(id: number, generation: number) { const w = new Writer(); w.u8(7); w.u32(id); w.u32(generation); return w.finish(); }
export function decodeTracking(bytes: Uint8Array, c: Capabilities, request: Request, generation: number): Packet {
  check(bytes.length <= (request.delivery === 1 ? MAX_PACKET - 1 : MAX_CONTROL - 1), "Publication size limit");
  const r = new Reader(bytes), id = r.u32(), gen = r.u32(), timestamp = r.u64();
  check(id === request.id && gen === generation, "Unexpected tracking generation");
  const available = r.bitmap(request.samples.length);
  const booleans = r.bitmap(request.samples.filter((s, i) => available(i) && s.format === 1).length);
  let bit = 0;
  const values = request.samples.map((s, i): Value | null => {
    if (!available(i)) return null;
    const d = c.descriptors[s.descriptor]; check(compatible(d.kind, s.format), "Invalid layout");
    if (s.format === 1) return booleans(bit++);
    const v = Array.from({ length: components(d.kind) }, () => r.number(s.format));
    if ([8, 9, 10, 16].includes(d.kind)) {
      const numbers = v as number[];
      check(numbers.every(Number.isFinite), "Nonfinite sample");
      if (d.kind === 8 || d.kind === 16) check(numbers[0] >= 0 && numbers[0] <= 1, "Invalid normalized value");
      if (d.kind === 9) check(numbers.every(n => n >= -1 && n <= 1), "Invalid thumbstick");
      if (d.kind === 10) check(Math.abs(numbers.slice(3).reduce((sum, n) => sum + n * n, 0) - 1) <= (s.format === 10 ? 1e-5 : 1e-12), "Invalid quaternion");
    }
    return v.length === 1 ? v[0] : v as number[];
  });
  r.done(); return { id, generation: gen, timestamp, values };
}
export function counterDelta(current: bigint, previous: bigint, format: number) {
  return BigInt.asUintN(width(format) * 8, current - previous);
}
