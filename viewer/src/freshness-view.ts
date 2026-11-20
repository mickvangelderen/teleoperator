import "./freshness-view.css";
import { setAttribute, setSelectableText } from "./dom";
import type { Freshness } from "./freshness";
import type { GroupMetric } from "./group-metrics";
import type { Capabilities } from "./protocol";
import { groupLabel } from "./group-name";
import { groupColor, mountGroupLegend, mountSparkline } from "./sparkline";
import type { MetricDisplay } from "./ui/metric-display";
import { formatMeasurement } from "./ui/format";
import { TwoSecondMedian } from "./statistics";

export function mountFreshnessIndicator(container: MetricDisplay) {
  const chart = mountSparkline(container, "freshness-chart", "Sample acquisition → use for frame computation.\nNo render-to-photon delay is added.\nHeadline: 2 s median of the oldest used continuous sample.\nGroup values: 2 s medians. Delivery health is separate.");
  const delivery = document.createElement("strong"); delivery.id = "freshness-delivery";
  chart.tooltip.prepend(delivery);
  const groups = mountGroupLegend(chart.tooltip, "ms");
  const sampleMedian = new TwoSecondMedian(), deliveryMedian = new TwoSecondMedian(), thresholdMedian = new TwoSecondMedian();
  return {
    reset() { chart.reset(); sampleMedian.reset(); deliveryMedian.reset(); thresholdMedian.reset(); },
    update(metrics: GroupMetric[], health: Freshness, capabilities?: Capabilities) {
      const { worst, atMs: now } = health;
      // Preserve transport health for existing consumers; its threshold applies
      // to first delivery, never to acquisition-to-frame sample freshness.
      setAttribute(container, "data-status", health.status);
      const continuous = metrics.filter(group => group.continuous);
      const available = continuous.flatMap(group => group.freshness === undefined ? [] : [group.freshness]);
      container.update(sampleMedian.update(available.length ? Math.max(...available) : undefined, now));
      const delivered = deliveryMedian.update(worst?.ageMs, now);
      const threshold = thresholdMedian.update(worst?.thresholdMs, now);
      setSelectableText(delivery, `Delivery: ${health.status === "Stalled" ? "no new samples" : health.status.toLowerCase()} · ${formatMeasurement(delivered, "ms", 1)} · late above ${formatMeasurement(threshold, "ms", 1)}`);
      groups(continuous.map(group => ({ group: group.group, label: groupLabel(capabilities, group.group), value: group.medianFreshness })));
      chart.update(continuous.map(group => ({ key: group.key, value: group.freshness, color: groupColor(group.group), peak: true, className: "freshness-age-line" })), now);
    },
  };
}
