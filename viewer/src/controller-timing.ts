// Per controller subscription. A change-only source can be silent indefinitely.
import type { Timing } from "./protocol";
import type { ClockEstimate } from "./clock";

const maxObservations = 64;
const slotAt = (t: bigint, { phase, interval }: Timing) =>
  t - ((t - phase) % interval + interval) % interval;

export class ControllerTiming {
  private samples: number[] = [];
  private guardMs = 0;
  private qualified = 0;
  private first = true;
  private updatedAt = -Infinity;
  private lastSlot?: bigint;

  changed(now: number) {
    this.updatedAt = now;
    this.lastSlot = undefined;
  }

  observe(acquired: bigint, arrived: number, timing: Timing, clock: ClockEstimate, upperOffset: bigint) {
    if (this.first) { this.first = false; return; } // Initial publication may be off-grid.
    const settling = Math.max(3 * Number(timing.interval) / 1e6, 2 * Number(clock.delay) / 1e6);
    if (arrived - this.updatedAt < settling || arrived - clock.at > 2000) return;
    const local = BigInt(Math.round(arrived * 1e6));
    const upper = local + upperOffset;
    const slot = slotAt(acquired, timing);
    // The sender selects the latest elapsed slot when it handles the opportunity,
    // after acquisition and before receipt. Both times must imply the same slot.
    if (upper < acquired || slot !== slotAt(upper, timing)) {
      // An ambiguous packet cannot retire an earlier slow delivery.
      this.samples.length = 0;
      return;
    }
    if (slot === this.lastSlot) return;
    this.lastSlot = slot;
    const delay = Math.max(0, Number(local + clock.offset - slot) / 1e6);
    this.qualified = Math.min(8, this.qualified + 1);
    this.samples.push(delay);
    if (this.samples.length > maxObservations) this.samples.shift();
    // Reserve another ordinary late excursion on a variable path. An isolated
    // high-water observation affects the peak once, not the ordinary spread.
    const sorted = [...this.samples].sort((a, b) => a - b);
    const last = sorted.length - 1;
    const spread = sorted[Math.floor(last * 0.9)] - sorted[Math.floor(last / 2)];
    const guard = sorted[last] + spread;
    this.guardMs = sorted.length === maxObservations ? guard : Math.max(this.guardMs, guard);
  }

  deliveryMs() {
    // Attack on a slow delivery and release only after newer publications.
    // Quiet frames and ACK silence provide no evidence of a faster path.
    return this.qualified >= 8 ? this.guardMs : undefined;
  }
}
