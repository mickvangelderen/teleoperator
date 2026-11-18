// PRO-0021 software clock. Durations use seconds; absolute timestamps remain bigint.
export type ClockEstimate = { offset: bigint; delay: bigint; at: number };
export const BROWSER_CLOCK_PRECISION_NS = 100_000n; // Non-isolated floor: https://www.w3.org/TR/hr-time/#dfn-coarsen-time
type Observation = { residual: number; residualNs: bigint; delay: bigint; at: number };
const clamp = (v: number) => Math.max(-0.0005, Math.min(0.0005, v));
export class SoftwareClock {
  offset = 0n;
  rate = 0;
  phase = 0;
  aligned = false;
  private advancedAt?: number;
  private acceptedAt = -Infinity;
  private history: Observation[] = [];
  private previousResidual = 0;
  private spike?: Observation;
  private latest?: { delay: bigint; at: number };
  private fraction = 0;
  readonly probeSeconds = 0.25;

  constructor(readonly precisionNs = BROWSER_CLOCK_PRECISION_NS) {
    if (precisionNs <= 0n) throw new Error("Clock precision must be positive");
  }
  estimate(now: number): ClockEstimate | undefined {
    this.advance(now);
    return this.aligned && this.latest ? { ...this.latest, offset: this.offset } : undefined;
  }
  advance(now: number) {
    if (this.advancedAt === undefined) { this.advancedAt = now; return; }
    if (now <= this.advancedAt) return;
    let elapsed = (now - this.advancedAt) / 1000;
    this.advancedAt = now;
    const tau = 16 * this.probeSeconds, requested = this.rate + this.phase / tau, correction = clamp(requested);
    let adjustment = 0;
    // Integrate the bounded phase decay exactly, so rendering/query cadence does
    // not alter the clock discipline. Learned frequency persists during holdover.
    if (correction !== requested) {
      const slope = this.rate - correction;
      const untilUnclipped = slope === 0 ? Infinity : (tau * (correction - this.rate) - this.phase) / slope;
      const clipped = Math.min(elapsed, Math.max(0, untilUnclipped));
      adjustment += correction * clipped;
      this.phase += slope * clipped;
      elapsed -= clipped;
    }
    const remainingPhase = this.phase * Math.exp(-elapsed / tau);
    adjustment += this.rate * elapsed + this.phase - remainingPhase;
    this.phase = remainingPhase;
    const ns = adjustment * 1e9 + this.fraction, whole = Math.round(ns);
    this.offset += BigInt(whole); this.fraction = ns - whole;
  }
  capture(now: number) { this.advance(now); return BigInt(Math.round(now * 1e6)) + this.offset; }
  observe(t1: bigint, t2: bigint, t3: bigint, t4: bigint, now: number): { observation: Observation; alignedNow: boolean; reinitialized?: boolean } {
    this.advance(now);
    const rawDelay = (t4 - t1) - (t3 - t2), delay = rawDelay < this.precisionNs ? this.precisionNs : rawDelay;
    const residualNs = ((t2 - t1) + (t3 - t4)) / 2n;
    const observation = { residualNs, residual: Number(residualNs) / 1e9, delay, at: now };
    this.history.push(observation);
    this.history = this.history.slice(-8);
    const selected = this.history.reduce((best, o) => o.delay <= best.delay ? o : best);
    if (!this.aligned) {
      if (this.history.length < 4) return { observation, alignedNow: false };
      this.offset += selected.residualNs;
      this.aligned = true; this.acceptedAt = now; this.history = [];
      this.latest = { delay: selected.delay, at: now };
      return { observation, alignedNow: true };
    }
    if (selected.at > this.acceptedAt) {
      const e = selected.residual;
      // An isolated millisecond-scale excursion must not teach a frequency error.
      const spike = Math.abs(e - this.previousResidual) > Math.max(0.002, 4 * Number(selected.delay) / 1e9);
      if (spike && (!this.spike || selected.at <= this.spike.at || Math.abs(e - this.spike.residual) > 0.002)) {
        this.spike = selected;
        // A rejected minimum must never confirm itself on a later ordinary reply.
        this.history = this.history.filter(o => o !== selected);
        return { observation, alignedNow: false };
      } else if (Math.abs(e) > 1) {
        // A sustained origin step cannot be slewed away at the rate limit.
        this.aligned = false; this.rate = this.phase = this.previousResidual = 0;
        this.history = [selected]; this.spike = undefined;
        this.latest = undefined;
        return { observation, alignedNow: false, reinitialized: true };
      } else {
        const elapsed = (now - this.acceptedAt) / 1000;
        this.rate = clamp(this.rate + e * Math.min(elapsed, 2048) / (4 * 16 * this.probeSeconds) ** 2);
        this.phase = e; this.acceptedAt = now; this.previousResidual = e; this.spike = undefined;
      }
    }
    this.latest = { delay: selected.delay, at: now };
    return { observation, alignedNow: false };
  }
}
