// Missing counts are provisional: an out-of-order packet can fill a gap.
// Packets older than the bounded reorder window are counted separately.
export class Sequence {
  highest = 0n;
  first = 0n;
  unique = 0n;
  duplicates = 0n;
  reordered = 0n;
  tooLate = 0n;
  private readonly seen: bigint[] = [];
  constructor(private readonly startAtOne = true, private readonly window = 4096n) {
    if (window < 1n || window > 65_536n) throw new Error("Invalid sequence window");
  }
  get missing() { return this.highest ? this.highest - this.first + 1n - this.unique : 0n; }
  accept(number: bigint): boolean {
    if (number <= 0n) throw new Error("Sequence numbers must be positive");
    if (!this.first) this.first = this.startAtOne ? 1n : number;
    if (number < this.first || number <= this.highest - this.window) { this.tooLate++; return false; }
    const slot = Number(number % this.window);
    if (this.seen[slot] === number) { this.duplicates++; return false; }
    if (number < this.highest) this.reordered++;
    this.highest = number > this.highest ? number : this.highest;
    this.unique++;
    this.seen[slot] = number;
    return true;
  }
}

export class Latest<T> {
  pending: T | null = null;
  coalesced = 0;
  consumed = 0;
  put(value: T) { if (this.pending !== null) this.coalesced++; this.pending = value; }
  take(): T | null { const value = this.pending; this.pending = null; if (value !== null) this.consumed++; return value; }
}
