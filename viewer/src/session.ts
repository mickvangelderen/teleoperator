import { decodeServer, MAX_SERVER_MESSAGE, counterDelta, counterKind, decodeTracking, offer, subscribe, unsubscribe, updateSchedule, validateRequest, validateSchedule, publicationRate, NON_MAX, width } from "./protocol";
import type { Capabilities, Packet, Request, Schedule, ServerMessage } from "./protocol";
import { FreshnessBaseline, summarizeFreshness } from "./freshness";
import type { StreamFreshness } from "./freshness";

type ReceivedPrediction = { packet: Packet; arrivedAt: number };
export type Subscription = {
  request: Request; generation: number; packet?: Packet; arrivedAt?: number; acquiredAtArrival?: number;
  counters: Map<number, bigint>; deltas: Map<number, bigint>;
  arrivals: number[]; packets: number; bytes: number;
  deliveryObservations?: { acquired: bigint; arrived: number }[];
  predictions?: ReceivedPrediction[];
  predictionFloor?: bigint;
  consumed?: ReceivedPrediction;
  freshness: FreshnessBaseline;
};
export const selectedPacket = (s: Subscription) => s.consumed?.packet ?? s.packet;
export class Session {
  phase: "selection" | "capabilities" | "ready" | "closed" = "selection";
  capabilities?: Capabilities;
  readonly active = new Map<number, Subscription>();
  readonly pending = new Map<number, Request>();
  readonly stopping = new Set<number>();
  readonly revisions = new Map<number, { value: bigint; bits: number; timestamp: bigint; changedAt?: bigint }>();
  private nextGeneration = 1; // Local metric identity; never transmitted.
  private nextId = 1;
  detail = "Negotiating connection…";
  discarded = 0;
  clock?: { offset: bigint; delay: bigint; at: number };
  consumptionTime?: bigint;
  private nextClock = 0;
  private readonly clockRequests = new Map<number, bigint>();
  private clockObservations: { offset: bigint; delay: bigint; at: number }[] = [];
  start() { return offer(); }
  retire() {
    this.phase = "closed"; this.capabilities = undefined;
    this.active.clear(); this.pending.clear(); this.stopping.clear();
    this.revisions.clear();
    this.clockRequests.clear(); this.clockObservations = []; this.clock = undefined;
  }
  request(request: Request) {
    if (this.phase !== "ready" || !this.capabilities || this.pending.has(request.id) || this.stopping.has(request.id)) throw new Error("Subscription request is not currently allowed");
    const r = { ...request, schedule: { ...request.schedule }, samples: request.samples.map(s => ({ ...s })) };
    validateRequest(this.capabilities, r);
    this.pending.set(r.id, r); return subscribe(r);
  }
  stop(id: number) {
    const active = this.active.get(id);
    if (!active || this.pending.has(id) || this.stopping.has(id)) throw new Error("No accepted subscription available to stop");
    this.stopping.add(id); this.active.delete(id);
    return unsubscribe(id);
  }
  allocateId() {
    while (this.active.has(this.nextId) || this.pending.has(this.nextId) || this.stopping.has(this.nextId)) this.nextId++;
    if (this.nextId > 0xffffffff) throw new Error("Subscription ids exhausted; reconnect");
    return this.nextId++;
  }
  changeSchedule(id: number, schedule: Schedule) {
    const sub = this.active.get(id);
    if (!sub || this.pending.has(id) || this.stopping.has(id)) throw new Error("No accepted subscription available to update");
    validateSchedule(schedule, this.capabilities!.groups[sub.request.group]);
    const bytes = updateSchedule(id, schedule);
    const previous = sub.request.schedule;
    sub.request.schedule = { ...schedule };
    if (previous.kind !== schedule.kind || (previous.kind === "periodic" && schedule.kind === "periodic" && previous.interval !== schedule.interval)) sub.freshness = new FreshnessBaseline();
    return bytes;
  }
  control(bytes: Uint8Array, arrivedAt = performance.now()) {
    const message = decodeServer(bytes);
    if (message.tag === 9) {
      if (this.phase !== "ready") throw new Error("Publication before capabilities");
      return this.tracking(message.body, arrivedAt, 2);
    }
    this.receive(message);
    return null;
  }

  requestClock(now: number) {
    if (!["capabilities", "ready"].includes(this.phase) || this.nextClock > 0xffffffff) return undefined;
    const at = BigInt(Math.round(now * 1e6));
    for (const [id, sent] of this.clockRequests) if (at - sent > 10_000_000_000n) this.clockRequests.delete(id);
    if (this.clockRequests.size >= 16) return undefined;
    const id = this.nextClock++, bytes = new Uint8Array(5);
    bytes[0] = 10; new DataView(bytes.buffer).setUint32(1, id, true);
    this.clockRequests.set(id, at); return bytes;
  }
  unreliable(bytes: Uint8Array, arrivedAt: number): Packet | null {
    if (!["capabilities", "ready"].includes(this.phase) || bytes.length > MAX_SERVER_MESSAGE) { this.discarded++; return null; }
    if (bytes[0] === 9) return this.tracking(bytes.subarray(1), arrivedAt);
    if (bytes[0] !== 11 || bytes.length !== 21) { this.discarded++; return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), id = view.getUint32(1, true);
    const t1 = this.clockRequests.get(id), t2 = view.getBigUint64(5, true), t3 = view.getBigUint64(13, true), t4 = BigInt(Math.round(arrivedAt * 1e6));
    if (t1 === undefined || t2 === NON_MAX || t3 === NON_MAX || t3 < t2 || t4 < t1 || t4 - t1 > 10_000_000_000n) { this.discarded++; return null; }
    this.clockRequests.delete(id);
    const delay = (t4 - t1) - (t3 - t2);
    if (delay < 0n) { this.discarded++; return null; }
    this.clockObservations = this.clockObservations.filter(o => arrivedAt - o.at <= 30_000).slice(-7);
    this.clockObservations.push({ offset: ((t2 - t1) + (t3 - t4)) / 2n, delay, at: arrivedAt });
    // Prefer low-delay probes, but age out their offsets promptly so clock drift is followed.
    this.clock = this.clockObservations.filter(o => arrivedAt - o.at < 2000).reduce((best, o) => o.delay <= best.delay ? o : best);
    return null;
  }
  sampleAge(timestamp: bigint, now: number, renderToPhotonMs = 0) {
    if (!this.clock || now - this.clock.at > 30_000) return undefined;
    return Number(BigInt(Math.round(now * 1e6)) - timestamp + this.clock.offset) / 1e6 + renderToPhotonMs;
  }
  consume(now: number, offsetMs = 0) {
    const target = this.clock && now >= this.clock.at && now - this.clock.at <= 30_000
      ? BigInt(Math.round((now + offsetMs) * 1e6)) + this.clock.offset : undefined;
    this.consumptionTime = target;
    const distance = (p: Packet) => { const d = p.predictedFor! - target!; return d < 0n ? -d : d; };
    for (const s of this.active.values()) {
      if (target === undefined || s.packet?.predictedFor == null || !s.predictions?.length) {
        s.consumed = undefined;
        continue;
      }
      let best = s.predictions[0];
      for (const candidate of s.predictions) {
        const delta = distance(candidate.packet) - distance(best.packet);
        if (delta < 0n || (delta === 0n && candidate.packet.timestamp > best.packet.timestamp)) best = candidate;
      }
      s.consumed = best;
      // Older past predictions cannot become a better match as consumption advances.
      // Keep the best past sample and future samples; arrivals are independently bounded.
      s.predictions = s.predictions.filter(p => p === best || p.packet.predictedFor! >= target);
    }
  }
  // Policies can evaluate at their own control tick; freshness does not imply sample validity.
  freshness(now: number) {
    const streams: StreamFreshness[] = [];
    for (const sub of this.active.values()) {
      if (sub.request.schedule.kind === "onChange") continue;
      const age = sub.packet && this.sampleAge(sub.packet.timestamp, now);
      const ageMs = age !== undefined && age >= 0 ? age : undefined;
      const { thresholdMs, latencyMs, jitterMs } = sub.freshness;
      streams.push({ id: sub.request.id, group: sub.request.group, generation: sub.generation, intervalMs: 1000 / publicationRate(sub.request),
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
  sampleArrivalDelay(id: number, now: number) {
    if (!this.clock) return undefined;
    // Keep server timestamps so a refined clock estimate rebases the entire window.
    const delays = (this.active.get(id)?.deliveryObservations ?? [])
      .filter(o => o.arrived > now - 2000 && o.arrived <= now)
      .map(o => Number(BigInt(Math.round(o.arrived * 1e6)) + this.clock!.offset - o.acquired) / 1e6)
      .filter(delay => delay >= 0 && delay <= 1000).sort((a, b) => a - b);
    return delays.length < 8 ? undefined : delays[Math.ceil(delays.length * 0.9) - 1];
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
        if (!request || this.active.has(message.id)) throw new Error("Unexpected subscription acceptance");
        this.pending.delete(message.id);
        this.active.set(message.id, { request, generation: this.nextGeneration++, counters: new Map(), deltas: new Map(), arrivals: [], packets: 0, bytes: 0, freshness: new FreshnessBaseline() });
        this.detail = `Subscription ${message.id} accepted`; break;
      }
      case 6:
        if (!this.pending.delete(message.id)) throw new Error("Unexpected subscription rejection");
        this.detail = `Subscription ${message.id} rejected${message.reason === undefined ? "" : `: ${message.reason}`}`; break;
      case 8: {
        this.active.delete(message.id); this.stopping.delete(message.id);
        this.detail = `Subscription ${message.id} ended: ${message.reason}`; break;
      }
      default: throw new Error("Server message in invalid session phase");
    }
  }
  tracking(bytes: Uint8Array, arrivedAt: number, delivery = 1): Packet | null {
    if (bytes.length < 20 || !this.capabilities) { this.discarded++; return null; }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), active = this.active.get(view.getUint32(0, true));
    if (!active || active.request.delivery !== delivery) { this.discarded++; return null; }
    let packet: Packet;
    try { packet = decodeTracking(bytes, this.capabilities, active.request); }
    catch { this.discarded++; return null; }
    const older = active.packet !== undefined && packet.timestamp < active.packet.timestamp;
    // Current or historical runtime samples (such as body tracking) use the newest acquisition.
    const forecast = packet.predictedFor !== null && packet.predictedFor > packet.timestamp;
    const revisionChanged = active.packet && active.request.samples.some((selection, i) =>
      this.capabilities!.descriptors[selection.descriptor].kind === 11
      && packet.values[i] !== active.packet!.values[i]);
    if (!older && (!forecast || revisionChanged)) {
      active.predictions = undefined; active.consumed = undefined;
      // Reordering must not resurrect predictions from before this discontinuity.
      active.predictionFloor = packet.timestamp;
    }
    // A reordered prediction can still be the best value for this consumption tick.
    // Retain it without rewinding the latest acquisition, revisions or input counters.
    const retained = forecast && !(older && revisionChanged)
      && (active.predictionFloor === undefined || packet.timestamp >= active.predictionFloor);
    if (retained) {
      const predictions = active.predictions ??= [];
      while (predictions.length && (predictions.length >= 256 || predictions[0].arrivedAt < arrivedAt - 2000)) predictions.shift();
      predictions.push({ packet, arrivedAt });
    }
    if (older) { if (!retained) this.discarded++; return null; }
    active.deltas.clear();
    packet.values.forEach((value, i) => {
      const s = active.request.samples[i];
      const descriptor = this.capabilities!.descriptors[s.descriptor];
      if (descriptor.kind === 11) {
        const group = descriptor.revision_of!, previous = this.revisions.get(group);
        if (!previous || packet.timestamp >= previous.timestamp) {
          const current = BigInt(value as number | bigint), bits = 8 * width(s.format);
          const changed = previous && BigInt.asUintN(Math.min(bits, previous.bits), current) !== BigInt.asUintN(Math.min(bits, previous.bits), previous.value);
          this.revisions.set(group, { value: current, bits, timestamp: packet.timestamp, changedAt: changed ? packet.timestamp : previous?.changedAt });
        }
      }
      if (!counterKind(this.capabilities!.descriptors[s.descriptor].kind)) return;
      const current = BigInt(value as number | bigint), previous = active.counters.get(i);
      if (previous !== undefined) active.deltas.set(i, counterDelta(current, previous, s.format));
      active.counters.set(i, current);
    });
    const acquired = !active.packet || packet.timestamp > active.packet.timestamp;
    if (acquired) {
      active.acquiredAtArrival = arrivedAt;
      if (active.request.schedule.kind === "periodic") {
        const observations = active.deliveryObservations ??= [];
        while (observations.length && (observations.length >= 256 || observations[0].arrived < arrivedAt - 2000)) observations.shift();
        observations.push({ acquired: packet.timestamp, arrived: arrivedAt });
      }
    }
    active.packet = packet; active.arrivedAt = arrivedAt; active.packets++; active.bytes += bytes.length;
    if (acquired && active.request.schedule.kind !== "onChange") active.freshness.observe(this.sampleAge(packet.timestamp, arrivedAt), arrivedAt, 1000 / publicationRate(active.request), Number(this.clock?.delay ?? 0n) / 2e6);
    active.arrivals.push(arrivedAt);
    while (active.arrivals[0] < arrivedAt - 1000) active.arrivals.shift();
    return packet;
  }
}
