import "./freshness-view.css";
import { setAttribute, setSelectableText } from "./dom";
import { summarizeFreshness } from "./freshness";
import type { Freshness } from "./freshness";
import type { Capabilities } from "./protocol";
import { groupLabel } from "./group-name";
import { groupColor, mountGroupLegend, mountSparkline } from "./sparkline";
import type { MetricDisplay } from "./ui/metric-display";
import { formatMeasurement } from "./ui/format";
import { TwoSecondMedian } from "./statistics";

export function mountFreshnessIndicator(container: MetricDisplay) {
  const chart = mountSparkline(container, "freshness-chart", "Solid: delivery time. Dashed: late threshold.\nGroup values: 2 s medians of the worst subscription.");
  const threshold = document.createElement("strong"); threshold.id = "freshness-threshold";
  chart.tooltip.prepend(threshold);
  const groups = mountGroupLegend(chart.tooltip, "ms");
  const ageMedian = new TwoSecondMedian(), thresholdMedian = new TwoSecondMedian();
  const histories = new Map<number, { membership: string; median: TwoSecondMedian }>();
  return {
    reset() { chart.reset(); ageMedian.reset(); thresholdMedian.reset(); histories.clear(); },
    update(freshness: Freshness, capabilities?: Capabilities) {
      const { worst, atMs: now, streams } = freshness;
      setAttribute(container, "data-status", freshness.status);
      const displayedAge = ageMedian.update(worst?.ageMs, now);
      const displayedThreshold = thresholdMedian.update(worst?.thresholdMs, now);
      container.update(displayedAge);
      setSelectableText(threshold, worst?.status === "Stalled" ? `${groupLabel(capabilities, worst.group)} · no new samples` : `Late above ${formatMeasurement(displayedThreshold, "ms", 1)}`);
      const groupIds = [...new Set(streams.map(stream => stream.group))].sort((a, b) => a - b);
      for (const group of histories.keys()) if (!groupIds.includes(group)) histories.delete(group);
      groups(groupIds.map(group => {
        const members = streams.filter(s => s.group === group).sort((a, b) => a.id - b.id);
        const membership = members.map(s => `${s.id}:${s.generation}`).join(",");
        let history = histories.get(group);
        if (!history || history.membership !== membership) {
          history = { membership, median: new TwoSecondMedian() }; histories.set(group, history);
        }
        const worst = summarizeFreshness(members, now).worst;
        return { group, label: groupLabel(capabilities, group), value: history.median.update(worst?.ageMs, now),
          status: worst?.status === "Stalled" ? "No new samples" : undefined };
      }));
      chart.update(streams.flatMap(s => [
        { key: `${s.id}:${s.generation}:threshold`, value: s.thresholdMs, color: groupColor(s.group), dashed: true, className: "freshness-threshold-line" },
        { key: `${s.id}:${s.generation}:age`, value: s.ageMs, color: groupColor(s.group), peak: true, className: "freshness-age-line" },
      ]), now);
    },
  };
}
