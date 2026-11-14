export class Latest<T> {
  pending: T | null = null;
  coalesced = 0;
  consumed = 0;
  put(value: T) { if (this.pending !== null) this.coalesced++; this.pending = value; }
  take(): T | null { const value = this.pending; this.pending = null; if (value !== null) this.consumed++; return value; }
}

// Sum of values in (now - 1000 ms, now], including partial startup windows.
export class RollingRate {
  private samples: { at: number; value: number }[] = [];
  private first = 0;
  private total = 0;
  add(at: number, value = 1) {
    this.rate(at);
    this.samples.push({ at, value });
    this.total += value;
  }
  rate(now: number) {
    while (this.first < this.samples.length && this.samples[this.first].at <= now - 1000)
      this.total -= this.samples[this.first++].value;
    if (this.first > 512 || this.first === this.samples.length) {
      this.samples = this.samples.slice(this.first); this.first = 0;
    }
    return this.total;
  }
  clear() { this.samples.length = 0; this.first = 0; this.total = 0; }
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
