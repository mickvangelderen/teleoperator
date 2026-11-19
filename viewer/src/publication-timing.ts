import type { Timing } from "./protocol";
import { median } from "./statistics";

import { BROWSER_CLOCK_PRECISION_NS, type ClockEstimate } from "./clock";
const ns = (ms: number) => BigInt(Math.round(ms * 1e6));
const modulo = (value: bigint, interval: bigint) => ((value % interval) + interval) % interval;
export const SCHEDULE_UPDATE_INTERVAL_MS = 1000;
const phaseDeadbandNs = 1_000_000n;

// Browser frame callbacks estimate consumption opportunities, not physical scanout.
// renderToPhotonMs remains the user's display-delay estimate; no server horizon is assumed.
export class PublicationTiming {
  private lastFrame?: number;
  private intervals: number[] = [];
  private callbackDelays: number[] = [];
  private processing: { at: number; duration: number }[] = [];
  private clockAfter = -Infinity;

  reset(now: number) {
    this.lastFrame = undefined;
    this.intervals = []; this.callbackDelays = []; this.processing = [];
    this.clockAfter = now;
  }

  frame(frameTime: number, now: number) {
    if (!Number.isFinite(frameTime) || !Number.isFinite(now) || now < frameTime || now - frameTime > 250) {
      this.reset(now); return;
    }
    if (this.lastFrame !== undefined) {
      const interval = frameTime - this.lastFrame;
      if (interval <= 0 || interval > 250) this.reset(now);
      else { this.intervals.push(interval); this.intervals = this.intervals.slice(-12); }
    }
    this.lastFrame = frameTime;
    this.callbackDelays.push(now - frameTime);
    this.callbackDelays = this.callbackDelays.slice(-12);
  }

  received(duration: number, now: number) {
    if (Number.isFinite(duration) && duration >= 0) this.processing.push({ at: now, duration });
    this.processing = this.processing.filter(p => now - p.at < 2000).slice(-64);
  }

  schedule(current: Timing, now: number, renderToPhotonMs: number, clock?: ClockEstimate, transitMs?: number, maxRate = Infinity, controllerDeliveryMs?: number): Timing | undefined {
    if (!clock || clock.at < this.clockAfter || now < clock.at || now - clock.at > 3000 || clock.delay < 0n
      || this.lastFrame === undefined || now - this.lastFrame > 250 || this.intervals.length < 4
      || !Number.isFinite(renderToPhotonMs) || renderToPhotonMs < 0 || renderToPhotonMs > 1000) return;
    const transit = transitMs ?? Number(clock.delay) / 2e6;
    if (!Number.isFinite(transit) || transit < 0 || transit > 1000) return;
    const typical = median(this.intervals);
    // Average ordinary frame intervals to avoid treating rAF timestamp rounding
    // as a refresh-rate change; exclude missed frames from the estimate.
    const ordinary = this.intervals.filter(interval => Math.abs(interval - typical) < typical / 4);
    const cadence = ordinary.reduce((sum, interval) => sum + interval, 0) / ordinary.length;
    if (!Number.isFinite(cadence) || cadence < 1 || cadence > 100) return;
    if (!(maxRate > 0)) return;
    const minimumInterval = BigInt(Math.ceil(1e9 / maxRate));
    const measuredInterval = BigInt(Math.ceil(cadence * 1e6));
    let interval = measuredInterval > minimumInterval ? measuredInterval : minimumInterval;
    const intervalError = interval > current.interval ? interval - current.interval : current.interval - interval;
    if (current.interval >= minimumInterval && intervalError <= current.interval / 1000n) interval = current.interval;
    const callbackDelay = median(this.callbackDelays);
    const frameJitter = median(this.intervals.map(i => Math.abs(i - cadence)));
    const costs = this.processing.filter(p => now - p.at < 2000).map(p => p.duration).sort((a, b) => a - b);
    const receiveCost = Math.max(1, costs[Math.floor((costs.length - 1) * 0.9)] ?? 1);
    // Leave time for decoding plus a small arrival margin, enlarged by measured jitter.
    // Acquisition can precede a publication slot by a full device poll or more.
    // Only clock probes estimate transit independently of the retained sample's age.
    const probeJitter = Math.abs(transit - Number(clock.delay) / 2e6);
    const arrivalMargin = 2 + Math.min(50, 2 * frameJitter + probeJitter);
    let lead = transit + Math.min(50, receiveCost) + arrivalMargin;
    if (controllerDeliveryMs !== undefined) {
      // Delivery ends at callback entry. Add actual receive work and phase
      // uncertainty once. A fresh clock filter sample on the data channel
      // already includes sender wake, transport and browser dispatch.
      const resolution = Number(BROWSER_CLOCK_PRECISION_NS) / 1e6;
      const measuredCost = costs[Math.floor((costs.length - 1) * 0.9)];
      const decode = measuredCost === undefined ? receiveCost : measuredCost + resolution;
      const earlyCallback = callbackDelay - Math.min(...this.callbackDelays);
      lead = controllerDeliveryMs + decode + resolution + earlyCallback + 2 * frameJitter;
    }
    // Choose an upcoming render far enough away for the reliable update to reach the server.
    const anchor = this.lastFrame + callbackDelay;
    const framesAhead = Math.max(1, Math.ceil((now + transit + 2 + lead - anchor) / cadence));
    const renderAt = anchor + framesAhead * cadence;
    return {
      interval,
      phase: modulo(ns(renderAt - lead) + clock.offset, interval),
      predictionOffset: ns(lead + renderToPhotonMs),
    };
  }
}

export function scheduleNeedsUpdate(current: Timing, next: Timing, phaseTolerance = phaseDeadbandNs) {
  if (current.interval !== next.interval) return true;
  const distance = modulo(next.phase - current.phase, current.interval);
  const phaseError = distance < current.interval - distance ? distance : current.interval - distance;
  const delayError = next.predictionOffset - current.predictionOffset;
  // Avoid churn from timestamp quantization, callback jitter and small probe changes.
  return phaseError > phaseTolerance || delayError > 500_000n || delayError < -500_000n;
}
