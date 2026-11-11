export class Latest<T> {
  pending: T | null = null;
  coalesced = 0;
  consumed = 0;
  put(value: T) { if (this.pending !== null) this.coalesced++; this.pending = value; }
  take(): T | null { const value = this.pending; this.pending = null; if (value !== null) this.consumed++; return value; }
}
