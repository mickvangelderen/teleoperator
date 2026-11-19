import { BROWSER_CLOCK_PRECISION_NS, type ClockEstimate } from "./clock";
import type { Timing } from "./protocol";

const windowSize = 8;
const precisionMs = Number(BROWSER_CLOCK_PRECISION_NS) / 1e6;
const slotAt = (t: bigint, { phase, interval }: Timing) =>
  t - ((t - phase) % interval + interval) % interval;

type Delivery = { delay: number; arrived: number };

// RFC 5905 §10 and A.5.2. Use the timing of the lowest-delay delivery in
// eight arrivals once. The gate protects the persistent estimate on turnover.
class DeliveryFilter {
  private history: Delivery[] = [];
  private accepted?: Delivery;
  private examinedAt = -Infinity;

  observe(delay: number, arrived: number, pollMs: number) {
    this.history.push({ delay, arrived });
    if (this.history.length > windowSize) this.history.shift();
    if (this.history.length < windowSize) return;
    const best = this.history.reduce((a, b) => b.delay <= a.delay ? b : a);
    if (best.arrived <= this.examinedAt) return;
    this.examinedAt = best.arrived;
    const squared = this.history.reduce((sum, s) => sum + (s.delay - best.delay) ** 2, 0);
    const jitter = Math.max(precisionMs, Math.sqrt(squared / (this.history.length - 1)));
    if (this.accepted && Math.abs(best.delay - this.accepted.delay) > 3 * jitter
      && best.arrived - this.accepted.arrived < 2 * pollMs) return;
    this.accepted = best;
  }

  value() { return this.accepted?.delay; }

  // Only an admitted change may advance the requested slot between ordinary
  // updates. Raw late deliveries remain visible in actual consumption metrics.
  lateSince(budget: number, since: number) {
    return budget > 0 && this.accepted !== undefined && this.accepted.arrived > since && this.accepted.delay > budget;
  }
}

export class ControllerTiming {
  private readonly margin = new DeliveryFilter();
  private first = true;
  private unattributed = 0;
  private updatedAt = -Infinity;
  private changedBefore?: bigint;
  private anchor?: { slot: bigint; position?: bigint };

  changed(now: number, upperOffset?: bigint) {
    this.updatedAt = now;
    this.changedBefore = upperOffset === undefined ? undefined : BigInt(Math.round(now * 1e6)) + upperOffset;
    this.anchor = undefined;
  }

  observe(acquired: bigint, arrived: number, timing: Timing, clock: ClockEstimate, upperOffset: bigint, position?: bigint) {
    if (this.first) { this.first = false; return; } // The initial publication may be off-grid.
    const settling = Math.max(3 * Number(timing.interval) / 1e6, 2 * Number(clock.delay) / 1e6);
    if (arrived - this.updatedAt < settling || arrived - clock.at > 2000) return;
    const local = BigInt(Math.round(arrived * 1e6));
    const upper = local + upperOffset;
    if (upper < acquired || (!this.anchor && this.changedBefore !== undefined && acquired <= this.changedBefore)) return;
    let lower = slotAt(acquired, timing);
    if (position !== undefined && this.anchor?.position !== undefined) {
      if (position <= this.anchor.position) return;
      // At most one successful sequence increment per publication slot. Loss,
      // idle slots and backpressure can only increase the true slot distance.
      const earliest = this.anchor.slot + (position - this.anchor.position) * timing.interval;
      if (earliest > lower) lower = earliest;
    }
    const latest = slotAt(upper, timing);
    if (lower !== latest) {
      // Contradictory bounds invalidate this epoch's sequence anchor. An
      // ordinary ambiguous interval leaves all earlier valid state intact.
      if (lower > latest) this.anchor = undefined;
      this.unattributed = Math.min(windowSize, this.unattributed + 1);
      return;
    }
    if (this.anchor && lower <= this.anchor.slot) return;
    this.anchor = { slot: lower, position };
    this.unattributed = 0;
    const delay = Number(local + clock.offset - lower) / 1e6;
    if (delay >= 0) this.margin.observe(delay, arrived, Number(timing.interval) / 1e6);
  }

  deliveryMs() {
    // Sustained multi-slot transit may be unidentifiable from this wire format.
    // Keep the learned state, but allow the independently measured probe fallback.
    return this.unattributed === windowSize ? undefined : this.margin.value();
  }

  missedBudgetSince(budget: number, since: number) {
    return this.margin.lateSince(budget, Math.max(since, this.updatedAt));
  }
}
