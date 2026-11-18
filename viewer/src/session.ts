import { decodeServer, MAX_SERVER_MESSAGE, counterDelta, counterKind, decodeTracking, offer, subscribe, unsubscribe, updateSchedule, validateRequest, validateTiming, publicationRate, NON_MAX, width, acknowledge, sequencePosition, changedOnly } from "./protocol";
import type { Capabilities, Packet, Request, Timing, ServerMessage, Value } from "./protocol";
import { FreshnessBaseline, summarizeFreshness } from "./freshness";
import type { StreamFreshness } from "./freshness";

import { SoftwareClock } from "./clock";
type ReceivedPrediction = { packet: Packet; values: Value[]; arrivedAt: number; acquiredAtArrival: number };
export type ReceivedBundle = ReceivedPrediction & { position: bigint; predictions: ReceivedPrediction[]; consumed?: ReceivedPrediction };
export type Subscription = {
  request: Request; generation: number; packet?: Packet; arrivedAt?: number; acquiredAtArrival?: number;
  bundles: (ReceivedBundle | undefined)[]; newestPosition?: bigint; version: number;
  counters: Map<number, bigint>; deltas: Map<number, bigint>;
  arrivals: number[]; packets: number; bytes: number;
  freshness: FreshnessBaseline;
};
export const selectedBundle = (s: Subscription, index: number) => s.bundles[index]?.consumed ?? s.bundles[index];
export class Session {
  phase: "selection" | "capabilities" | "ready" | "closed" = "selection";
  capabilities?: Capabilities;
  readonly active = new Map<number, Subscription>();
  readonly pending = new Map<number, Request>();
  readonly stopping = new Set<number>();
  readonly outcomes = new Map<number, { status: "accepted" | "rejected" | "ended"; reason?: string }>();
  readonly revisions = new Map<number, { value: bigint; bits: number; timestamp: bigint; changedAt?: bigint }>();
  private nextGeneration = 1; // Local metric identity; never transmitted.
  private nextId = 1;
  detail = "Negotiating connection…";
  discarded = 0;
  consumptionTime?: bigint;
  private nextClock = 0;
  private readonly clockRequests = new Map<number, { sent: bigint; at: number }>();
  private softwareClock = new SoftwareClock();
  private acknowledgments: { id: number; bytes: Uint8Array }[] = [];
  private clockObservations: { delay: bigint; at: number }[] = [];
  start() { return offer(); }
  retire() {
    this.phase = "closed"; this.capabilities = undefined;
    this.active.clear(); this.pending.clear(); this.stopping.clear(); this.outcomes.clear();
    this.revisions.clear();
    this.clockRequests.clear(); this.clockObservations = [];
    this.softwareClock = new SoftwareClock(); this.acknowledgments = []; this.consumptionTime = undefined;
  }
  request(request: Request) {
    if (this.phase !== "ready" || !this.capabilities || this.pending.has(request.id) || this.stopping.has(request.id)) throw new Error("Subscription request is not currently allowed");
    const r = { ...request, bundles: request.bundles.map(b => b.map(s => ({ ...s }))) };
    validateRequest(this.capabilities, r);
    this.outcomes.delete(r.id);
    this.acknowledgments = this.acknowledgments.filter(a => a.id !== r.id);
    this.pending.set(r.id, r); return subscribe(r);
  }
  stop(id: number) {
    const active = this.active.get(id);
    if (!active || this.pending.has(id) || this.stopping.has(id)) throw new Error("No accepted subscription available to stop");
    this.stopping.add(id); this.active.delete(id);
    this.acknowledgments = this.acknowledgments.filter(a => a.id !== id);
    return unsubscribe(id);
  }
  allocateId() {
    while (this.active.has(this.nextId) || this.pending.has(this.nextId) || this.stopping.has(this.nextId)) this.nextId++;
    if (this.nextId > 0xffffffff) throw new Error("Subscription ids exhausted; reconnect");
    return this.nextId++;
  }
  changeSchedule(id: number, timing: Timing) {
    const sub = this.active.get(id);
    if (!sub || this.pending.has(id) || this.stopping.has(id)) throw new Error("No accepted subscription available to update");
    validateTiming(timing);
    const bytes = updateSchedule(id, timing);
    if (sub.request.interval !== timing.interval) sub.freshness = new FreshnessBaseline();
    Object.assign(sub.request, { interval: timing.interval, phase: timing.phase, predictionOffset: timing.predictionOffset });
    return bytes;
  }
  takeAcknowledgments() { const ready = this.acknowledgments; this.acknowledgments = []; return ready.map(a => a.bytes); }
  control(bytes: Uint8Array, arrivedAt = performance.now()) {
    // Publications have discard semantics even before discovery and on Reliable.
    if (bytes[0] === 9) return this.tracking(bytes.subarray(1), arrivedAt, 2);
    this.receive(decodeServer(bytes)); return null;
  }
  // Every caller requests a mapping at its own monotonic time; no shared snapshot is mutated.
  clockEstimate(now: number) { return this.softwareClock.estimate(now); }

  requestClock(now: number) {
    if (!["capabilities", "ready"].includes(this.phase) || this.nextClock > 0xffffffff) return undefined;
    const sent = this.softwareClock.capture(now);
    for (const [id, request] of this.clockRequests) if (now - request.at > 10_000) this.clockRequests.delete(id);
    if (this.clockRequests.size >= 16) return undefined;
    const id = this.nextClock++, bytes = new Uint8Array(5);
    bytes[0] = 10; new DataView(bytes.buffer).setUint32(1, id, true);
    this.clockRequests.set(id, { sent, at: now }); return bytes;
  }
  unreliable(bytes: Uint8Array, arrivedAt: number): Packet | null {
    if (!["capabilities", "ready"].includes(this.phase) || bytes.length > MAX_SERVER_MESSAGE) { this.discarded++; return null; }
    if (bytes[0] === 9) return this.tracking(bytes.subarray(1), arrivedAt);
    if (bytes[0] !== 11 || bytes.length !== 21) { this.discarded++; return null; }
    const t4 = this.softwareClock.capture(arrivedAt);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), id = view.getUint32(1, true);
    const request = this.clockRequests.get(id), t2 = view.getBigUint64(5, true), t3 = view.getBigUint64(13, true);
    if (!request || t2 === NON_MAX || t3 === NON_MAX || t3 < t2 || arrivedAt < request.at || arrivedAt - request.at > 10_000) { this.discarded++; return null; }
    this.clockRequests.delete(id);
    const result = this.softwareClock.observe(request.sent, t2, t3, t4, arrivedAt);
    this.clockObservations = this.clockObservations.filter(o => arrivedAt - o.at <= 30_000).slice(-127);
    this.clockObservations.push(result.observation);
    if (result.alignedNow || result.reinitialized) this.clockRequests.clear();
    return null;
  }
  sampleAge(timestamp: bigint, now: number, renderToPhotonMs = 0) {
    const clock = this.clockEstimate(now);
    if (!clock || now < clock.at || now - clock.at > 30_000) return undefined;
    return Number(BigInt(Math.round(now * 1e6)) + clock.offset - timestamp) / 1e6 + renderToPhotonMs;
  }
  consume(now: number, offsetMs = 0) {
    const clock = this.clockEstimate(now);
    const target = clock && now >= clock.at && now - clock.at <= 30_000
      ? BigInt(Math.round((now + offsetMs) * 1e6)) + clock.offset : undefined;
    this.consumptionTime = target;
    for (const s of this.active.values()) for (const b of s.bundles) {
      if (!b) continue;
      b.consumed = undefined;
      if (target === undefined || !b.predictions.length) continue;
      const distance = (p: ReceivedPrediction) => { const d = p.packet.predictedFor! - target; return d < 0n ? -d : d; };
      let best = b.predictions[0];
      for (const p of b.predictions) if (distance(p) < distance(best) || (distance(p) === distance(best) && p.packet.timestamp > best.packet.timestamp)) best = p;
      b.consumed = best;
      b.predictions = b.predictions.filter(p => p === best || p.packet.predictedFor! >= target);
    }
  }
  // Policies can evaluate at their own control tick; freshness does not imply sample validity.
  freshness(now: number) {
    const streams: StreamFreshness[] = [];
    for (const sub of this.active.values()) {
      if (changedOnly(sub.request)) continue;
      const continuous = sub.bundles[0];
      const age = continuous && this.sampleAge(continuous.packet.timestamp, now);
      const ageMs = age !== undefined && age >= 0 ? age : undefined;
      const intervalMs = 1000 / publicationRate(sub.request);
      // A rate change can reset the baseline while the source is stalled.
      // Evaluate a known acquisition against the same probe bootstrap used on arrival.
      if (ageMs !== undefined && sub.freshness.thresholdMs === undefined) {
        const clock = this.clockEstimate(now);
        if (clock) sub.freshness.bootstrap(intervalMs, Number(clock.delay) / 2e6);
      }
      const { thresholdMs, latencyMs, jitterMs } = sub.freshness;
      streams.push({ id: sub.request.id, group: sub.request.group, generation: sub.generation, intervalMs,
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
        if (!request) throw new Error("Unexpected subscription acceptance");
        this.pending.delete(message.id);
        this.outcome(message.id, "accepted");
        this.active.set(message.id, { request, bundles: request.bundles.map(() => undefined), version: 0, generation: this.nextGeneration++, counters: new Map(), deltas: new Map(), arrivals: [], packets: 0, bytes: 0, freshness: new FreshnessBaseline() });
        this.detail = `Subscription ${message.id} accepted`; break;
      }
      case 6:
        if (!this.pending.delete(message.id)) throw new Error("Unexpected subscription rejection");
        this.outcome(message.id, "rejected", message.reason);
        this.detail = `Subscription ${message.id} rejected${message.reason === undefined ? "" : `: ${message.reason}`}`; break;
      case 8: {
        this.active.delete(message.id); this.stopping.delete(message.id);
        this.outcome(message.id, "ended", message.reason);
        this.acknowledgments = this.acknowledgments.filter(a => a.id !== message.id);
        this.detail = `Subscription ${message.id} ended: ${message.reason}`; break;
      }
      default: throw new Error("Server message in invalid session phase");
    }
  }
  private outcome(id: number, status: "accepted" | "rejected" | "ended", reason?: string) {
    this.outcomes.delete(id); this.outcomes.set(id, { status, reason });
    if (this.outcomes.size > 128) this.outcomes.delete(this.outcomes.keys().next().value!);
  }
  tracking(bytes: Uint8Array, arrivedAt: number, delivery = 1): Packet | null {
    if (bytes.length < 20 || !this.capabilities || this.phase !== "ready") { this.discarded++; return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), active = this.active.get(view.getUint32(0, true));
    if (!active || active.request.delivery !== delivery || (delivery === 1 && this.pending.has(active.request.id))) { this.discarded++; return null; }
    let packet: Packet;
    try { packet = decodeTracking(bytes, this.capabilities, active.request); }
    catch { this.discarded++; return null; }
    const format = active.request.sequenceNumberFormat;
    const position = format === null ? packet.timestamp : sequencePosition(packet.sequenceNumber!, active.newestPosition, format);
    if (position === null) { this.discarded++; return null; }
    if (active.newestPosition === undefined || position > active.newestPosition) {
      active.newestPosition = position;
    }
    if (format !== null && packet.bundles.some((b, i) => i > 0 && b !== null) && !this.pending.has(packet.id)) {
      this.acknowledgments.push({ id: packet.id, bytes: acknowledge(packet.id, format, packet.sequenceNumber!) });
      if (this.acknowledgments.length > 128) this.acknowledgments.shift();
    }
    active.deltas.clear();
    let applied = false, flatIndex = 0;
    packet.bundles.forEach((values, index) => {
      const selections = active.request.bundles[index], previous = active.bundles[index];
      const start = flatIndex; flatIndex += selections.length;
      if (!values || (previous && (format === null ? position < previous.position : position <= previous.position))) return;
      applied = true;
      const acquired = !previous || packet.timestamp > previous.packet.timestamp;
      const received = { packet, values, arrivedAt, acquiredAtArrival: acquired ? arrivedAt : previous!.acquiredAtArrival };
      const predictions = packet.predictedFor !== null && packet.predictedFor > packet.timestamp
        ? [...(previous?.predictions ?? []).filter(p => p.arrivedAt >= arrivedAt - 2000).slice(-255), received] : [];
      active.bundles[index] = { ...received, position, predictions };
      values.forEach((value, i) => {
        const selection = selections[i], descriptor = this.capabilities!.descriptors[selection.descriptor], key = start + i;
        if (descriptor.kind === 11) {
          const group = descriptor.revision_of!, old = this.revisions.get(group);
          if (!old || packet.timestamp >= old.timestamp) {
            const current = BigInt(value as number | bigint), bits = 8 * width(selection.format);
            const changed = old && BigInt.asUintN(Math.min(bits, old.bits), current) !== BigInt.asUintN(Math.min(bits, old.bits), old.value);
            this.revisions.set(group, { value: current, bits, timestamp: packet.timestamp, changedAt: changed ? packet.timestamp : old?.changedAt });
          }
        }
        if (!counterKind(descriptor.kind)) return;
        const current = BigInt(value as number | bigint), old = active.counters.get(key);
        if (old !== undefined) active.deltas.set(key, counterDelta(current, old, selection.format));
        active.counters.set(key, current);
      });
      if (index === 0 && acquired && selections.length) {
        active.acquiredAtArrival = arrivedAt;
        active.freshness.observe(this.sampleAge(packet.timestamp, arrivedAt), arrivedAt, 1000 / publicationRate(active.request), Number(this.clockEstimate(arrivedAt)?.delay ?? 0n) / 2e6);
      }
    });
    active.packets++; active.bytes += bytes.length; active.arrivals.push(arrivedAt);
    while (active.arrivals[0] < arrivedAt - 1000) active.arrivals.shift();
    if (!applied) return null;
    if (!active.packet || packet.timestamp >= active.packet.timestamp) active.packet = packet;
    active.arrivedAt = arrivedAt; active.version++;
    return packet;
  }
}
