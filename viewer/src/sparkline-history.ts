export class SparklineHistory {
  readonly samples: { at: number; value?: number }[] = [];
  add(now: number, value?: number, peak = false) {
    const at = Math.floor(now / 100) * 100, last = this.samples.at(-1);
    if (value !== undefined && !Number.isFinite(value)) value = undefined;
    if (last?.at === at) {
      if (!peak) last.value = value;
      else if (value !== undefined) last.value = Math.max(last.value ?? value, value);
    }
    else this.samples.push({ at, value });
    while (this.samples.length && this.samples[0].at < now - 10_000) this.samples.shift();
  }
}

