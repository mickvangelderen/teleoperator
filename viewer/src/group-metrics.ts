import { changedOnly, publicationRate, restGroup } from "./protocol";
import { selectedBundle } from "./session";
import type { Session, Subscription } from "./session";
import { TwoSecondMedian } from "./statistics";
import { staleBundle } from "./tracking-view";

type History = { membership: string; arrival: TwoSecondMedian; age: TwoSecondMedian; freshness: TwoSecondMedian };
export type GroupMetric = {
  group: number; key: string; continuous: boolean; onChange: boolean;
  arrival: number; requested?: number; age?: number; freshness?: number;
  medianArrival?: number; medianAge?: number; medianFreshness?: number;
};
const mean = (values: (number | undefined)[]) => {
  const available = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  return available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : undefined;
};

// One observation per render tick and acquisition group, independent of sample count.
export class GroupMetrics {
  private session?: Session;
  private histories = new Map<number, History>();

  update(session: Session | undefined, now: number, renderToPhotonMs = 0) {
    if (session !== this.session) { this.histories.clear(); this.session = session; }
    const subscriptions = new Map<number, Subscription[]>();
    for (const sub of session?.active.values() ?? []) {
      const group = sub.request.group, members = subscriptions.get(group) ?? [];
      members.push(sub); subscriptions.set(group, members);
    }
    for (const group of this.histories.keys()) if (!subscriptions.has(group)) this.histories.delete(group);
    const groups: GroupMetric[] = [];
    for (const [group, members] of [...subscriptions].sort(([a], [b]) => a - b)) {
      members.sort((a, b) => a.request.id - b.request.id);
      const membership = members.map(s => `${s.request.id}:${s.generation}`).join(",");
      let history = this.histories.get(group);
      if (!history || history.membership !== membership) {
        history = { membership, arrival: new TwoSecondMedian(), age: new TwoSecondMedian(), freshness: new TwoSecondMedian() };
        this.histories.set(group, history);
      }
      const timed = members.filter(s => !changedOnly(s.request));
      const continuous = timed.length > 0 && !restGroup(session!.capabilities!, group);
      // This counts messages, including repeated acquisitions, not source samples.
      const arrival = members.reduce((sum, s) => sum + s.arrivals.filter(at => at > now - 1000 && at <= now).length, 0);
      let acquired: bigint | undefined, represented: bigint | undefined;
      let missing = false, missingTarget = false;
      if (continuous) for (const sub of timed) {
        // Use the same prediction selection and stale cutoff as the frame's
        // values. Reusing a current snapshot advances these intervals; an idle
        // period after it stops being used must not masquerade as sample use.
        const snapshot = selectedBundle(sub, 0);
        if (!snapshot || staleBundle(sub, 0, now)) { missing = true; continue; }
        const packet = snapshot.packet;
        if (acquired === undefined || packet.timestamp < acquired) acquired = packet.timestamp;
        if (packet.predictedFor === null) missingTarget = true;
        else if (represented === undefined || packet.predictedFor < represented) represented = packet.predictedFor;
      }
      // Acquisition-to-compute and represented-time-to-effect have different
      // endpoints. Only the latter includes the render-to-photon estimate.
      const freshness = !missing && acquired !== undefined ? session!.sampleAge(acquired, now) : undefined;
      const age = !missing && !missingTarget && represented !== undefined ? session!.sampleAge(represented, now, renderToPhotonMs) : undefined;
      groups.push({ group, key: `${group}:${membership}`, continuous, onChange: timed.length === 0,
        arrival, requested: timed.length ? timed.reduce((sum, s) => sum + publicationRate(s.request), 0) : undefined,
        age, freshness, medianArrival: history.arrival.update(arrival, now), medianAge: history.age.update(age, now),
        medianFreshness: history.freshness.update(freshness, now) });
    }
    const continuous = groups.filter(group => group.continuous);
    return { groups, arrival: mean(continuous.map(g => g.medianArrival)), age: mean(continuous.map(g => g.medianAge)) };
  }
}
