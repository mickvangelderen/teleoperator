// Version 1 wire contract; no device identities or rendering assumptions.
// Operator binding bounds, including the tag; WebRTC handles fragmentation.
export const MAX_CLIENT_MESSAGE = 65_535;
export const MAX_SERVER_MESSAGE = 1_048_576;
export const kindNames = ["invalid", "generic", "pressed", "press_count", "release_count", "touched", "touch_count", "untouch_count", "trigger", "thumbstick", "pose", "revision", "position_valid", "orientation_valid", "position_tracked", "orientation_tracked", "confidence"];
export const formatNames = ["invalid", "bit", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64", "unorm8", "unorm16", "snorm8", "snorm16"];
export const spaceNames = ["absent", "view", "local", "stage", "local_floor", "parent", "model"];
export const referenceKinds = { press_count_sample: 3, release_count_sample: 4, touch_count_sample: 6, untouch_count_sample: 7, position_valid_sample: 12, orientation_valid_sample: 13, position_tracked_sample: 14, orientation_tracked_sample: 15, confidence_sample: 16 } as const;
export type ReferenceField = keyof typeof referenceKinds;
export type Descriptor = { id: string; name: string; description: string; kind: number; formats: number[]; group: number; spaces: number[]; revision_of?: number } & Partial<Record<ReferenceField, number | null>>;
export const referenceFields = (kind: number): ReferenceField[] => kind === 2 ? ["press_count_sample", "release_count_sample"] : kind === 5 ? ["touch_count_sample", "untouch_count_sample"] : kind === 10 ? ["position_valid_sample", "orientation_valid_sample", "position_tracked_sample", "orientation_tracked_sample", "confidence_sample"] : [];
export const preferredFormat = (d: Descriptor) => d.kind === 10 && d.formats.includes(10) ? 10 : d.formats.includes(3) ? 3 : d.formats[0];
export type Joint = { parent: number; pose_sample: number; rest_pose_sample: number };
export type Capabilities = { groups: number[]; descriptors: Descriptor[]; skeletons: { joints: Joint[] }[] };
export function restGroup(c: Capabilities, group: number) {
  const live = new Set(c.skeletons.flatMap(s => s.joints.map(j => j.pose_sample)));
  const rest = new Set(c.skeletons.flatMap(s => s.joints.map(j => j.rest_pose_sample)).filter(i => !live.has(i)));
  return c.descriptors.some((d, i) => d.group === group && rest.has(i))
    && c.descriptors.every((d, i) => d.group !== group || rest.has(i) || d.kind === 11);
}
export type Selection = { descriptor: number; format: number; space: number };
export const NON_MAX = 0xffffffffffffffffn;
export type Timing = { interval: bigint; phase: bigint; predictionOffset: bigint };
export const timing = (rate: number, phase = 0n, predictionOffset = 0n): Timing => {
  check(Number.isFinite(rate) && rate > 0, "Invalid publication rate");
  const result = { interval: BigInt(Math.ceil(1e9 / rate)), phase, predictionOffset };
  validateTiming(result); return result;
};
export const publicationRate = (r: Timing) => 1e9 / Number(r.interval);
export function validateTiming(t: Timing) {
  check([t.interval, t.phase, t.predictionOffset].every(v => typeof v === "bigint" && v >= 0n && v < NON_MAX)
    && t.interval > 0n, "Invalid publication timing");
}
export type SequenceNumberFormat = 1 | 2 | 3;
export const sequenceWidth = (format: SequenceNumberFormat | null) => format === null ? 0 : 2 ** format;
export type Request = Timing & { id: number; group: number; delivery: number; sequenceNumberFormat: SequenceNumberFormat | null; bundles: Selection[][] };
export const bindings = (r: Request) => r.bundles.flat();
export const changedOnly = (r: Request) => r.bundles[0].length === 0;
export type ServerMessage =
  | { tag: 2; version: number } | { tag: 3; capabilities: Capabilities }
  | { tag: 5; id: number } | { tag: 6; id: number; reason?: string }
  | { tag: 8; id: number; reason: string }
  | { tag: 9; body: Uint8Array };
export type Value = boolean | number | bigint | number[];
export type Packet = { id: number; timestamp: bigint; predictedFor: bigint | null; sequenceNumber: bigint | null; bundles: (Value[] | null)[] };
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
    check(Number.isInteger(d.group) && d.group >= 0 && d.group < c.groups.length, "Invalid sample group");
    check(d.formats.length && d.formats.every(f => compatible(d.kind, f)), "Invalid sample formats");
    check(d.kind === 10 ? d.spaces.length && d.spaces.every(s => s >= 1 && s <= 6) : d.spaces.length === 0, "Invalid reference spaces");
    for (const field of referenceFields(d.kind)) {
      const index = d[field];
      check(index == null || c.descriptors[index]?.kind === referenceKinds[field], "Invalid descriptor reference");
    }
    if (d.kind === 11) check(Number.isInteger(d.revision_of) && d.revision_of! >= 0 && d.revision_of! < c.groups.length, "Invalid revision group");
  }
  check(c.skeletons.length <= 128, "Skeleton resource limit");
  let joints = 0;
  const parents = new Map<number, Set<number>>();
  for (const skeleton of c.skeletons) {
    joints += skeleton.joints.length;
    check(skeleton.joints.length && joints <= 4096, "Joint resource limit");
    for (const joint of skeleton.joints) {
      check(Number.isInteger(joint.parent) && joint.parent >= 0 && joint.parent < skeleton.joints.length && [joint.pose_sample, joint.rest_pose_sample].every(i => c.descriptors[i]?.kind === 10), "Invalid skeleton reference");
      for (const field of ["pose_sample", "rest_pose_sample"] as const) {
        const targets = parents.get(joint[field]) ?? new Set<number>();
        targets.add(skeleton.joints[joint.parent][field]); parents.set(joint[field], targets);
      }
    }
    const resolved = new Set<number>();
    for (let i = 0; i < skeleton.joints.length; i++) {
      const visiting = new Set<number>(); let at = i;
      while (!resolved.has(at)) {
        check(!visiting.has(at), "Skeleton parent cycle"); visiting.add(at);
        const parent = skeleton.joints[at].parent;
        if (parent === at) break;
        at = parent;
      }
      for (const index of visiting) resolved.add(index);
    }
  }
  c.descriptors.forEach((d, i) => {
    if (d.spaces.includes(5)) check(parents.get(i)?.size === 1, "Ambiguous or missing parent frame");
  });
}

export function validateRequest(c: Capabilities, r: Request) {
  check(r.delivery === 1 || r.delivery === 2, "Unsupported delivery mode");
  check(Number.isInteger(r.id) && r.id >= 0 && r.id <= 0xffffffff, "Invalid subscription id");
  check(Number.isInteger(r.group) && r.group >= 0 && r.group < c.groups.length, "Unknown group");
  validateTiming(r);
  check(r.sequenceNumberFormat === null || [1, 2, 3].includes(r.sequenceNumberFormat), "Invalid sequence format");
  check(r.bundles.length > 0 && (r.bundles.length === 1 || r.sequenceNumberFormat !== null), "Invalid bundle layout");
  let size = 21 + sequenceWidth(r.sequenceNumberFormat) + Math.ceil((r.bundles.length - 1) / 8);
  for (const bundle of r.bundles) {
    let bits = 0;
    for (const s of bundle) {
      const d = c.descriptors[s.descriptor];
      check(d && d.group === r.group && d.formats.includes(s.format) && compatible(d.kind, s.format), "Unsupported sample selection");
      check(d.kind === 10 ? d.spaces.includes(s.space) : s.space === 0, "Unsupported reference space");
      if (s.format === 1) bits++; else size += components(d.kind) * width(s.format);
    }
    size += Math.ceil(bits / 8);
  }
  check(size <= MAX_SERVER_MESSAGE, "Publication too large");
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
export function decodeServer(bytes: Uint8Array): ServerMessage {
  check(bytes.length <= MAX_SERVER_MESSAGE, "Message size limit");
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
    case 5: message = { tag, id: r.u32() }; break;
    case 6: {
      const id = r.u32(), present = r.u8(); check(present <= 1, "Invalid optional reason");
      message = { tag, id, reason: present ? r.string() : undefined }; break;
    }
    case 8: message = { tag, id: r.u32(), reason: r.string() }; break;
    case 9: message = { tag, body: bytes.slice(r.at) }; r.take(bytes.length - r.at); break;
    default: throw new Error("Invalid server message tag or direction");
  }
  r.done();
  return message;
}
class Writer {
  bytes: number[] = [];
  u8(n: number) { this.bytes.push(n); }
  u16(n: number) { this.bytes.push(n & 255, n >>> 8); }
  u32(n: number) { this.bytes.push(n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24); }
  u64(n: bigint) { const b = new ArrayBuffer(8); new DataView(b).setBigUint64(0, n, true); this.bytes.push(...new Uint8Array(b)); }
  timing(t: Timing) {
    validateTiming(t); this.u64(t.interval); this.u64(t.phase); this.u64(t.predictionOffset);
  }
  sequence(format: SequenceNumberFormat, value: bigint) {
    check(value >= 0n && value < (1n << BigInt(sequenceWidth(format) * 8)), "Invalid sequence number");
    if (format === 1) this.u16(Number(value)); else if (format === 2) this.u32(Number(value)); else this.u64(value);
  }
  finish() { return new Uint8Array(this.bytes); }
}
export function offer() { const w = new Writer(); w.u8(1); w.u32(1); w.u16(1); return w.finish(); }
export function subscribe(r: Request) {
  const w = new Writer(); w.u8(4); w.u32(r.id); w.u32(r.group); w.u8(r.delivery); w.timing(r);
  w.u8(r.sequenceNumberFormat ?? 0); w.u32(r.bundles.length);
  for (const bundle of r.bundles) {
    w.u32(bundle.length);
    for (const s of bundle) { w.u32(s.descriptor); w.u8(s.format); if (s.space) w.u8(s.space); }
  }
  return w.finish();
}
export function unsubscribe(id: number) { const w = new Writer(); w.u8(7); w.u32(id); return w.finish(); }
export function updateSchedule(id: number, timing: Timing) { const w = new Writer(); w.u8(12); w.u32(id); w.timing(timing); return w.finish(); }
export function acknowledge(id: number, format: SequenceNumberFormat, sequence: bigint) {
  const w = new Writer(); w.u8(13); w.u32(id); w.sequence(format, sequence); return w.finish();
}
// Positions are unwrapped relative to the newest subscription sequence, not a bundle's last sequence.
export function sequencePosition(sequence: bigint, newest: bigint | undefined, format: SequenceNumberFormat): bigint | null {
  if (newest === undefined) return sequence;
  const bits = sequenceWidth(format) * 8, range = 1n << BigInt(bits), half = range / 2n;
  const forward = BigInt.asUintN(bits, sequence - newest);
  return forward === half ? null : newest + (forward < half ? forward : forward - range);
}
export function decodeTracking(bytes: Uint8Array, c: Capabilities, request: Request): Packet {
  check(bytes.length <= (MAX_SERVER_MESSAGE - 1), "Publication size limit");
  const r = new Reader(bytes), id = r.u32(), timestamp = r.u64(), predicted = r.u64();
  const predictedFor = predicted === NON_MAX ? null : predicted;
  check(id === request.id && timestamp < NON_MAX, "Unexpected subscription or invalid acquisition time");
  const sequenceNumber = request.sequenceNumberFormat === null ? null
    : request.sequenceNumberFormat === 1 ? BigInt(r.u16()) : request.sequenceNumberFormat === 2 ? BigInt(r.u32()) : r.u64();
  const present = r.bitmap(request.bundles.length - 1);
  const bundles = request.bundles.map((bundle, index) => {
    if (index && !present(index - 1)) return null;
    const booleans = r.bitmap(bundle.filter(s => s.format === 1).length);
    let bit = 0;
    return bundle.map((s): Value => {
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
  });
  r.done(); return { id, timestamp, predictedFor, sequenceNumber, bundles };
}
export function counterDelta(current: bigint, previous: bigint, format: number) {
  return BigInt.asUintN(width(format) * 8, current - previous);
}
