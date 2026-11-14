export class Latest<T> {
  pending: T | null = null;
  coalesced = 0;
  consumed = 0;
  put(value: T) { if (this.pending !== null) this.coalesced++; this.pending = value; }
  take(): T | null { const value = this.pending; this.pending = null; if (value !== null) this.consumed++; return value; }
}

export class TwoSecondMedian {
  private samples: { at: number; value: number }[] = [];
  reset() { this.samples.length = 0; }
  update(value: number | undefined, now: number): number | undefined {
    if (value === undefined) { this.reset(); return undefined; }
    while (this.samples.length && this.samples[0].at <= now - 2000) this.samples.shift();
    this.samples.push({ at: now, value });
    return median(this.samples.map(sample => sample.value));
  }
}

export function median(values: number[]) {
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}
