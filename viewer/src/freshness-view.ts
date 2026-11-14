import { setAttribute, setText } from "./dom";
import type { Freshness } from "./freshness";
import { groupColor, mountGroupLegend, mountSparkline } from "./sparkline";
import { TwoSecondMedian } from "./statistics";

export function mountFreshnessIndicator(container: HTMLElement) {
  container.innerHTML = `<label>FRESHNESS</label>
    <div class="metric-value"><strong id="freshness-age">—</strong></div>`;
  const age = container.querySelector<HTMLElement>("#freshness-age")!;
  const chart = mountSparkline(container, "freshness-chart", "Solid: sample age. Dashed: late threshold.");
  const threshold = document.createElement("strong"); threshold.id = "freshness-threshold";
  chart.tooltip.prepend(threshold);
  const groups = mountGroupLegend(chart.tooltip);
  const ageMedian = new TwoSecondMedian(), thresholdMedian = new TwoSecondMedian();
  return {
    reset() { chart.reset(); ageMedian.reset(); thresholdMedian.reset(); },
    update(freshness: Freshness) {
      const { worst, atMs: now, streams } = freshness;
      setAttribute(container, "data-status", freshness.status);
      const displayedAge = ageMedian.update(worst?.ageMs, now);
      const displayedThreshold = thresholdMedian.update(worst?.thresholdMs, now);
      setText(age, displayedAge === undefined ? "—" : `${displayedAge.toFixed(1)} ms`);
      setText(threshold, displayedThreshold === undefined ? "Late above —" : `Late above ${displayedThreshold.toFixed(1)} ms`);
      groups(streams);
      chart.update(streams.flatMap(s => [
        { key: `${s.id}:${s.generation}:threshold`, value: s.thresholdMs, color: groupColor(s.group), dashed: true, className: "freshness-threshold-line" },
        { key: `${s.id}:${s.generation}:age`, value: s.ageMs, color: groupColor(s.group), peak: true, className: "freshness-age-line" },
      ]), now);
    },
  };
}
