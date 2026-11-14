import "./freshness-view.css";
import { setAttribute, setText } from "./dom";
import type { Freshness } from "./freshness";
import { groupColor, mountGroupLegend, mountSparkline } from "./sparkline";
import type { MetricDisplay } from "./ui/metric-display";
import { formatMeasurement } from "./ui/format";
import { TwoSecondMedian } from "./statistics";

export function mountFreshnessIndicator(container: MetricDisplay) {
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
      container.update(displayedAge);
      setText(threshold, `Late above ${formatMeasurement(displayedThreshold, "ms", 1)}`);
      groups(streams);
      chart.update(streams.flatMap(s => [
        { key: `${s.id}:${s.generation}:threshold`, value: s.thresholdMs, color: groupColor(s.group), dashed: true, className: "freshness-threshold-line" },
        { key: `${s.id}:${s.generation}:age`, value: s.ageMs, color: groupColor(s.group), peak: true, className: "freshness-age-line" },
      ]), now);
    },
  };
}
