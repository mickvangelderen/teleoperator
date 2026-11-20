import { changedOnly, publicationRate, restGroup } from "./protocol";
import { selectedBundle } from "./session";
import type { Session, Subscription } from "./session";
import { TwoSecondMedian } from "./statistics";
import { staleBundle } from "./tracking-view";

type History = { membership: string; arrival: TwoSecondMedian; age: TwoSecondMedian };
export type GroupMetric = {
  group: number; key: string; continuous: boolean; onChange: boolean;
  arrival: number; requested?: number; age?: number;
  medianArrival?: number; medianAge?: number;
};
const mean = (values: (number | undefined)[]) => values.length && values.every(v => v !== undefined)
  ? (values as number[]).reduce((sum, value) => sum + value, 0) / values.length : undefined;

// One observation per render tick and acquisition group, independent of sample count.
export class GroupMetrics {
  private session?: Session;
  private histories = new Map<number, History>();

  update(session: Session | undefined, now: number) {
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
        history = { membership, arrival: new TwoSecondMedian(), age: new TwoSecondMedian() };
        this.histories.set(group, history);
      }
      const timed = members.filter(s => !changedOnly(s.request));
      const continuous = timed.length > 0 && !restGroup(session!.capabilities!, group);
      // This counts messages, including repeated acquisitions, not source samples.
      const arrival = members.reduce((sum, s) => sum + s.arrivals.filter(at => at > now - 1000 && at <= now).length, 0);
      let oldest: bigint | undefined, missing = false;
      if (continuous) for (const sub of timed) {
        const snapshot = selectedBundle(sub, 0);
        if (!snapshot || staleBundle(sub, 0, now)) { missing = true; continue; }
        const represented = snapshot.packet.predictedFor;
        if (represented === null) { missing = true; continue; }
        if (oldest === undefined || represented < oldest) oldest = represented;
      }
      const age = !missing && oldest !== undefined ? session!.sampleAge(oldest, now) : undefined;
      groups.push({ group, key: `${group}:${membership}`, continuous, onChange: timed.length === 0,
        arrival, requested: timed.length ? timed.reduce((sum, s) => sum + publicationRate(s.request), 0) : undefined,
        age, medianArrival: history.arrival.update(arrival, now), medianAge: history.age.update(age, now) });
    }
    const continuous = groups.filter(group => group.continuous);
    return { groups, arrival: mean(continuous.map(g => g.medianArrival)), age: mean(continuous.map(g => g.medianAge)) };
  }
}
