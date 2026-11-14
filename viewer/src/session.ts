import { ControlDecoder, counterDelta, counterKind, decodeTracking, offer, restGroup, subscribe, unsubscribe, validateRequest, width } from "./protocol";
import type { Capabilities, Packet, Request, ServerMessage } from "./protocol";
import { FreshnessBaseline, summarizeFreshness } from "./freshness";
import type { StreamFreshness } from "./freshness";

export type Subscription = {
  request: Request; generation: number; onChange: boolean; packet?: Packet; arrivedAt?: number;
  counters: Map<number, bigint>; deltas: Map<number, bigint>;
  arrivals: number[]; packets: number; bytes: number;
  freshness: FreshnessBaseline;
};
export class Session {
  phase: "selection" | "capabilities" | "ready" | "closed" = "selection";
  capabilities?: Capabilities;
  readonly active = new Map<number, Subscription>();
  readonly pending = new Map<number, Request>();
  readonly stopping = new Map<number, number>();
  readonly revisions = new Map<number, { value: bigint; bits: number; timestamp: bigint; changedAt?: bigint }>();
  private readonly issued = new Map<number, number>();
  private readonly decoder = new ControlDecoder();
  detail = "Negotiating connection…";
  discarded = 0;
  clock?: { offset: bigint; delay: bigint; at: number };
  private nextClock = 0;
  private readonly clockRequests = new Map<number, bigint>();
  private clockObservations: { offset: bigint; delay: bigint; at: number }[] = [];
  start() { return offer(); }
  retire() {
    this.phase = "closed"; this.capabilities = undefined;
    this.active.clear(); this.pending.clear(); this.stopping.clear(); this.issued.clear(); this.decoder.reset();
    this.revisions.clear();
    this.clockRequests.clear(); this.clockObservations = []; this.clock = undefined;
  }
  request(request: Request) {
    if (this.phase !== "ready" || !this.capabilities || this.pending.has(request.id) || this.stopping.has(request.id)) throw new Error("Subscription request is not currently allowed");
    // The exact binary32 rate sent on wire is the accepted target.
    const r = { ...request, rate: Math.fround(request.rate), samples: request.samples.map(s => ({ ...s })) };
    validateRequest(this.capabilities, r);
    this.pending.set(r.id, r); return subscribe(r);
  }
  stop(id: number) {
    const active = this.active.get(id);
    if (!active || this.pending.has(id) || this.stopping.has(id)) throw new Error("No accepted subscription available to stop");
    this.stopping.set(id, active.generation); this.active.delete(id);
    return unsubscribe(id, active.generation);
  }
  control(bytes: Uint8Array, arrivedAt = performance.now()) {
    const packets: Packet[] = [];
    for (const message of this.decoder.feed(bytes)) {
      if (message.tag === 9) {
        if (this.phase !== "ready") throw new Error("Publication before capabilities");
        const packet = this.tracking(message.body, arrivedAt, 2);
        if (packet) packets.push(packet);
      } else this.receive(message);
    }
    return packets;
  }
  requestClock(now: number) {
    if (this.phase !== "ready" || this.nextClock > 0xffffffff) return undefined;
    const at = BigInt(Math.round(now * 1e6));
    for (const [id, sent] of this.clockRequests) if (at - sent > 10_000_000_000n) this.clockRequests.delete(id);
    if (this.clockRequests.size >= 16) return undefined;
    const id = this.nextClock++, bytes = new Uint8Array(5);
    bytes[0] = 10; new DataView(bytes.buffer).setUint32(1, id, true);
    this.clockRequests.set(id, at); return bytes;
  }
  unreliable(bytes: Uint8Array, arrivedAt: number): Packet | null {
    if (this.phase !== "ready" || bytes.length > 16_384) { this.discarded++; return null; }
    if (bytes[0] === 9) return this.tracking(bytes.subarray(1), arrivedAt);
    if (bytes[0] !== 11 || bytes.length !== 21) { this.discarded++; return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), id = view.getUint32(1, true);
    const t1 = this.clockRequests.get(id), t2 = view.getBigUint64(5, true), t3 = view.getBigUint64(13, true), t4 = BigInt(Math.round(arrivedAt * 1e6));
    if (t1 === undefined || t3 < t2 || t4 < t1 || t4 - t1 > 10_000_000_000n) { this.discarded++; return null; }
    this.clockRequests.delete(id);
    const delay = (t4 - t1) - (t3 - t2);
    if (delay < 0n) { this.discarded++; return null; }
    this.clockObservations = this.clockObservations.filter(o => arrivedAt - o.at <= 30_000).slice(-7);
    this.clockObservations.push({ offset: ((t2 - t1) + (t3 - t4)) / 2n, delay, at: arrivedAt });
    this.clock = this.clockObservations.reduce((best, o) => o.delay < best.delay ? o : best);
    return null;
  }
  sampleAge(timestamp: bigint, now: number, renderToPhotonMs = 0, predictionHorizonMs = 0) {
    if (!this.clock || now - this.clock.at > 30_000) return undefined;
    // shortcut: derive prediction time from acquisition + the fixed operator horizon until it is carried on wire.
    return Number(BigInt(Math.round(now * 1e6)) - timestamp + this.clock.offset) / 1e6 + renderToPhotonMs - predictionHorizonMs;
  }
  // Policies can evaluate at their own control tick; freshness does not imply sample validity.
  freshness(now: number) {
    const streams: StreamFreshness[] = [];
    for (const sub of this.active.values()) {
      if (sub.onChange) continue;
      const age = sub.packet && this.sampleAge(sub.packet.timestamp, now);
      const ageMs = age !== undefined && age >= 0 ? age : undefined;
      const { thresholdMs, latencyMs, jitterMs } = sub.freshness;
      streams.push({ id: sub.request.id, group: sub.request.group, generation: sub.generation, intervalMs: 1000 / sub.request.rate,
        ageMs, thresholdMs, latencyMs, jitterMs,
        status: ageMs === undefined || thresholdMs === undefined ? "Unknown" : ageMs > thresholdMs ? "Late" : "Fresh" });
    }
    return summarizeFreshness(streams, now);
  }
  latestNetworkLatency(now: number) {
    const probe = this.clockObservations.at(-1);
    return probe && probe.at > now - 2000 && probe.at <= now ? Number(probe.delay) / 2e6 : undefined;
  }
  networkLatency(now: number) {
    // Each probe contributes once; rendering and publication cadence do not weight the median.
    const delays = this.clockObservations.filter(o => o.at > now - 2000 && o.at <= now)
      .map(o => Number(o.delay) / 2e6).sort((a, b) => a - b);
    if (!delays.length) return undefined;
    const mid = Math.floor(delays.length / 2);
    return delays.length % 2 ? delays[mid] : (delays[mid - 1] + delays[mid]) / 2;
  }
  receive(message: ServerMessage) {
    if (this.phase === "closed") throw new Error("Session is closed");
    if (this.phase === "selection") {
      if (message.tag !== 2 || message.version !== 1) throw new Error("Server did not select offered protocol version 1");
      this.phase = "capabilities"; this.detail = "Discovering device capabilities…"; return;
    }
    if (this.phase === "capabilities") {
      if (message.tag !== 3) throw new Error("Expected capabilities after version selection");
      this.capabilities = message.capabilities;
      for (const d of this.capabilities.descriptors) { Object.freeze(d.formats); Object.freeze(d.spaces); Object.freeze(d); }
      for (const skeleton of this.capabilities.skeletons) {
        for (const joint of skeleton.joints) Object.freeze(joint);
        Object.freeze(skeleton.joints); Object.freeze(skeleton);
      }
      Object.freeze(this.capabilities.skeletons);
      Object.freeze(this.capabilities.groups); Object.freeze(this.capabilities.descriptors); Object.freeze(this.capabilities);
      this.phase = "ready"; this.detail = "Ready. Select samples to publish."; return;
    }
    switch (message.tag) {
      case 5: {
        const request = this.pending.get(message.id);
        if (!request || !message.generation || this.issued.has(message.generation) || this.active.has(message.id)) throw new Error("Unexpected subscription acceptance");
        if (this.issued.size >= 65536) throw new Error("Generation resource limit; reconnect");
        this.pending.delete(message.id); this.issued.set(message.generation, message.id);
        this.active.set(message.id, { request, generation: message.generation, onChange: request.delivery === 2 && restGroup(this.capabilities!, request.group), counters: new Map(), deltas: new Map(), arrivals: [], packets: 0, bytes: 0, freshness: new FreshnessBaseline() });
        this.detail = `Subscription ${message.id} accepted · generation ${message.generation}`; break;
      }
      case 6:
        if (!this.pending.delete(message.id)) throw new Error("Unexpected subscription rejection");
        this.detail = `Subscription ${message.id} rejected: ${message.reason}`; break;
      case 8: {
        if (this.issued.get(message.generation) !== message.id) throw new Error("Unknown ended generation");
        if (this.active.get(message.id)?.generation === message.generation) this.active.delete(message.id);
        if (this.stopping.get(message.id) === message.generation) this.stopping.delete(message.id);
        this.detail = `Subscription ${message.id} ended: ${message.reason}`; break;
      }
      default: throw new Error("Server message in invalid session phase");
    }
  }
  tracking(bytes: Uint8Array, arrivedAt: number, delivery = 1): Packet | null {
    if (bytes.length < 16 || !this.capabilities) { this.discarded++; return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), active = this.active.get(view.getUint32(0, true));
    if (!active || active.request.delivery !== delivery || active.generation !== view.getUint32(4, true)) { this.discarded++; return null; }
    let packet: Packet;
    try { packet = decodeTracking(bytes, this.capabilities, active.request, active.generation); }
    catch { this.discarded++; return null; }
    if (active.packet && packet.timestamp <= active.packet.timestamp) { this.discarded++; return null; }
    active.deltas.clear();
    packet.values.forEach((value, i) => {
      const s = active.request.samples[i];
      const descriptor = this.capabilities!.descriptors[s.descriptor];
      if (value !== null && descriptor.kind === 11) {
        const group = descriptor.revision_of!, previous = this.revisions.get(group);
        if (!previous || packet.timestamp >= previous.timestamp) {
          const current = BigInt(value as number | bigint), bits = 8 * width(s.format);
          const changed = previous && BigInt.asUintN(Math.min(bits, previous.bits), current) !== BigInt.asUintN(Math.min(bits, previous.bits), previous.value);
          this.revisions.set(group, { value: current, bits, timestamp: packet.timestamp, changedAt: changed ? packet.timestamp : previous?.changedAt });
        }
      }
      if (value === null || !counterKind(this.capabilities!.descriptors[s.descriptor].kind)) return;
      const current = BigInt(value as number | bigint), previous = active.counters.get(i);
      if (previous !== undefined) active.deltas.set(i, counterDelta(current, previous, s.format));
      active.counters.set(i, current);
    });
    active.packet = packet; active.arrivedAt = arrivedAt; active.packets++; active.bytes += bytes.length;
    if (!active.onChange) active.freshness.observe(this.sampleAge(packet.timestamp, arrivedAt), arrivedAt, 1000 / active.request.rate, Number(this.clock?.delay ?? 0n) / 2e6);
    active.arrivals.push(arrivedAt);
    while (active.arrivals[0] < arrivedAt - 1000) active.arrivals.shift();
    return packet;
  }
}
