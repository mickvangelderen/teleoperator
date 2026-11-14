import { Quaternion, Vector3 } from "three";
import type { Pose, PoseFrame, JointHierarchy } from "./body-model";
import type { Session, Subscription } from "./session";
import { width } from "./protocol";
import type { Value } from "./protocol";

export const poseSources = new Map([
  ["/user/head/input/pose", "head"],
  ["/user/hand/left/input/aim/pose", "left/aim"], ["/user/hand/left/input/grip/pose", "left/grip"],
  ["/user/hand/right/input/aim/pose", "right/aim"], ["/user/hand/right/input/grip/pose", "right/grip"],
]);
export const stale = (s: Subscription, now: number) => s.arrivedAt === undefined || (!s.onChange && now - s.arrivedAt > Math.max(500, 3000 / s.request.rate));
export type CurrentValue = { value: Value | null; stale: boolean; subscription: Subscription; selection: number };
export function currentValues(session: Session | undefined, now: number) {
  const values = new Map<number, CurrentValue>();
  for (const s of session?.active.values() ?? []) {
    s.request.samples.forEach((sample, i) => {
      const old = values.get(sample.descriptor);
      if (!old || (s.packet?.timestamp ?? -1n) > (old.subscription.packet?.timestamp ?? -1n)) values.set(sample.descriptor, { value: s.packet?.values[i] ?? null, stale: stale(s, now), subscription: s, selection: i });
    });
  }
  return values;
}
const missingPose = (): Pose => ({ position: [0, 0, 0], orientation: [0, 0, 0, 1], flags: 0, active: false });
type LocatedPose = { pose: Pose; space: number };
export function spatialFrames(session: Session | undefined, now: number, rest = false) {
  const poses: Pose[] = [], sources: string[] = [], body: PoseFrame = { poses: [], active: false }, hierarchy: JointHierarchy = { joints: [] };
  const current = currentValues(session, now), c = session?.capabilities, spaces = new Set<number>();
  const read = (index: number | null | undefined) => index == null || current.get(index)?.stale ? null : current.get(index)?.value ?? null;
  const outdated = new Set<number>();
  if (c) {
    for (const s of session?.active.values() ?? []) {
      const group = s.request.group, known = session?.revisions.get(group);
      if (!known || stale(s, now)) continue;
      // The self-revision proves which snapshot this publication contains. When it
      // wasn't selected, a later observed change invalidates the older snapshot.
      const revisionIndex = s.request.samples.findIndex(selection => {
        const revision = c.descriptors[selection.descriptor];
        return revision.kind === 11 && revision.revision_of === group;
      });
      const value = s.packet?.values[revisionIndex];
      if (value != null) {
        const bits = 8 * width(s.request.samples[revisionIndex].format);
        if (BigInt.asUintN(Math.min(known.bits, bits), known.value) !== BigInt.asUintN(Math.min(known.bits, bits), BigInt(value as number | bigint))) outdated.add(group);
      } else if (s.packet && known.changedAt !== undefined && s.packet.timestamp < known.changedAt) outdated.add(group);
    }
  }
  const located = (index: number): LocatedPose | undefined => {
    const d = c!.descriptors[index], value = read(index), sample = current.get(index);
    if (!sample || !Array.isArray(value) || outdated.has(d.group)) return;
    let flags = 0;
    for (const [field, bit, fallback] of [["position_valid_sample", 2, true], ["orientation_valid_sample", 1, true], ["position_tracked_sample", 8, false], ["orientation_tracked_sample", 4, false]] as const) {
      if (d[field] == null ? fallback : read(d[field]) === true) flags |= bit;
    }
    const tracking = [read(d.position_tracked_sample), read(d.orientation_tracked_sample)];
    // Missing tracking samples (including rest poses) are unknown, not a reported tracking loss.
    const tracked = tracking.includes(false) ? false : tracking.every(v => v === true) ? true : undefined;
    return { pose: { position: value.slice(0, 3), orientation: value.slice(3), flags, active: flags !== 0, tracked }, space: sample.subscription.request.samples[sample.selection].space };
  };
  const skeletonSamples = new Set<number>();
  c?.skeletons.forEach((skeleton, skeletonIndex) => {
    const resolved = new Map<number, LocatedPose | undefined>();
    const resolve = (start: number): LocatedPose | undefined => {
      const path: { index: number; result: LocatedPose }[] = [], visiting = new Set<number>();
      let i = start;
      while (!resolved.has(i)) {
        if (visiting.has(i)) { resolved.set(i, undefined); break; }
        visiting.add(i);
        const joint = skeleton.joints[i], result = located(rest ? joint.rest_pose_sample : joint.pose_sample);
        if (!result || result.space !== 5) { resolved.set(i, result); break; }
        if (joint.parent === i) {
          // A self-relative root anchors a rest skeleton only in its own frame.
          const p = result.pose;
          const identity = p.position.every(n => Math.abs(n) < 1e-6) && p.orientation.slice(0, 3).every(n => Math.abs(n) < 1e-6);
          resolved.set(i, rest && identity ? { pose: p, space: -skeletonIndex - 1 } : undefined); break;
        }
        path.push({ index: i, result }); i = joint.parent;
      }
      for (const { index, result } of path.reverse()) {
        const parent = resolved.get(skeleton.joints[index].parent);
        if (!parent || (parent.pose.flags & 3) !== 3) resolved.set(index, undefined);
        else {
          const rotation = new Quaternion().fromArray(parent.pose.orientation);
          const position = new Vector3().fromArray(result.pose.position).applyQuaternion(rotation).add(new Vector3().fromArray(parent.pose.position));
          const orientation = rotation.multiply(new Quaternion().fromArray(result.pose.orientation));
          resolved.set(index, { pose: { ...result.pose, position: position.toArray(), orientation: orientation.toArray() }, space: parent.space });
        }
      }
      return resolved.get(start);
    };
    const offset = body.poses.length;
    skeleton.joints.forEach((joint, i) => {
      skeletonSamples.add(joint.pose_sample); skeletonSamples.add(joint.rest_pose_sample);
      const result = resolve(i);
      body.poses.push(result?.pose ?? missingPose());
      hierarchy.joints.push({ id: offset + i, parent: joint.parent === i ? -1 : offset + joint.parent });
      if (result && result.pose.flags & 2) { spaces.add(result.space); body.active = true; }
    });
  });
  if (!rest) for (const [index] of current) {
    const d = c!.descriptors[index];
    if (d.kind !== 10 || skeletonSamples.has(index)) continue;
    const result = located(index);
    if (!result || result.space === 5 || !(result.pose.flags & 2)) continue;
    poses.push(result.pose); sources.push(poseSources.get(d.id) ?? d.id); spaces.add(result.space);
  }
  const confidences = c?.skeletons.flatMap(s => s.joints.flatMap(j => {
    const value = read(c.descriptors[j.pose_sample].confidence_sample);
    return typeof value === "number" ? [value] : [];
  })) ?? [];
  const confidence = confidences.length ? Math.min(...confidences) : undefined;
  const trackedJoints = body.poses.filter(p => (p.flags & 14) === 14).length;
  const mixedSpaces = spaces.size > 1;
  if (mixedSpaces) { poses.length = 0; sources.length = 0; body.active = false; }
  return { values: current, poses: { poses }, sources, body, hierarchy, mixedSpaces, space: spaces.size === 1 ? [...spaces][0] : undefined, outdated, confidence, trackedJoints, rest };
}
export function valueText(value: Value | null) {
  if (value === null) return "Unavailable";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(v => v.toFixed(3)).join(", ");
  return typeof value === "number" && !Number.isInteger(value) ? value.toFixed(4) : String(value);
}
