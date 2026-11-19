import { controlReading, descriptorIndices } from "./control-reading";
import { Quaternion, Vector3 } from "three";
import type { Pose, PoseFrame, JointHierarchy, BodyMeshFrame } from "./body-model";
import type { Session, Subscription } from "./session";
import { selectedBundle } from "./session";
import { width, publicationRate, bindings, restGroup, changedOnly } from "./protocol";
import type { Capabilities, Packet, Value } from "./protocol";

// Viewer conventions for the two operators that advertise a normalized gripper input.
export const gripperTriggers = new Map([
  ["/phone/input/grip/pose", "/phone/input/trigger/value"],
  ["/gamepad/virtual/pose", "/user/gamepad/input/trigger_right/value"],
]);
export const poseSources = new Map([
  ["/user/head/input/pose", "head"],
  ["/user/hand/left/input/aim/pose", "left/aim"], ["/user/hand/left/input/grip/pose", "left/grip"],
  ["/user/hand/right/input/aim/pose", "right/aim"], ["/user/hand/right/input/grip/pose", "right/grip"],
]);
export const staleBundle = (s: Subscription, index: number, now: number, retainedDefinition = false) => {
  const b = selectedBundle(s, index);
  if (!b) return true;
  if (retainedDefinition || (index > 0 && changedOnly(s.request))) return false;
  // Mixed bundles share the continuous bundle's source-acquisition progress.
  // New sequences with cached acquisitions and delayed per-bundle repairs cannot
  // extend it. Omitted bundles keep their own original acquisition timestamps.
  const progress = index === 0 ? b.acquiredAtArrival : s.acquiredAtArrival;
  return progress === undefined || now - progress > Math.max(500, 3000 / publicationRate(s.request));
};
export type CurrentValue = { value: Value | null; stale: boolean; subscription: Subscription; selection: number; packet?: Packet };
export function currentValues(session: Session | undefined, now: number) {
  const values = new Map<number, CurrentValue>();
  const distance = (packet: Packet | undefined) => {
    if (session?.consumptionTime === undefined || packet?.predictedFor == null || packet.predictedFor <= packet.timestamp) return undefined;
    const delta = packet.predictedFor - session.consumptionTime;
    return delta < 0n ? -delta : delta;
  };
  for (const s of session?.active.values() ?? []) {
    const retainedDefinition = !!session?.capabilities && restGroup(session.capabilities, s.request.group);
    let i = 0;
    s.request.bundles.forEach((bundle, index) => {
      const received = selectedBundle(s, index), packet = received?.packet;
      bundle.forEach((sample, within) => {
        const old = values.get(sample.descriptor);
        const error = distance(packet), previousError = distance(old?.packet);
        const closer = error !== undefined && previousError !== undefined && error !== previousError
          ? error < previousError : (packet?.timestamp ?? -1n) > (old?.packet?.timestamp ?? -1n);
        if (!old || closer) values.set(sample.descriptor, { value: received?.values[within] ?? null, stale: staleBundle(s, index, now, retainedDefinition), subscription: s, selection: i, packet });
        i++;
      });
    });
  }
  return values;
}
const missingPose = (): Pose => ({ position: [0, 0, 0], orientation: [0, 0, 0, 1], flags: 0, active: false });
export type StandalonePose = Pose & {
  subscription: Subscription; space: number; stale: boolean; closure?: number;
  positionTracked?: boolean; orientationTracked?: boolean;
};
// Standalone display references follow the selected acquisition even when another view is open.
const lastStandalone = new WeakMap<Session, Map<number, StandalonePose>>();
type LocatedPose = { pose: Pose; space: number; positionTracked?: boolean; orientationTracked?: boolean };
const meshMappings = new WeakMap<Capabilities, (number[] | undefined)[]>();
function bodyJointMappings(c: Capabilities) {
  const cached = meshMappings.get(c);
  if (cached) return cached;
  const mappings = c.skeletons.map(skeleton => {
    // Operator/asset convention only: generic skeletons still use the overlay.
    const ids = skeleton.joints.map(j => {
      const match = /^\/body\/FB\/(0|[1-9]\d*)$/.exec(c.descriptors[j.pose_sample].id);
      return match ? Number(match[1]) : undefined;
    });
    return ids.every((id): id is number => id !== undefined) && new Set(ids).size === ids.length ? ids : undefined;
  });
  // Session freezes discovery deeply. Do not retain mutable packet or pose data.
  if (Object.isFrozen(c)) meshMappings.set(c, mappings);
  return mappings;
}
export function spatialFrames(session: Session | undefined, now: number, rest = false, lateGenerations: ReadonlySet<number> = new Set()) {
  const poses: StandalonePose[] = [], sources: string[] = [], body: PoseFrame = { poses: [], active: false }, hierarchy: JointHierarchy = { joints: [] };
  let bodyMesh: BodyMeshFrame | undefined;
  let mappedSkeletons = 0;
  const current = currentValues(session, now), c = session?.capabilities, spaces = new Set<number>();
  const read = (index: number | null | undefined) => index == null || current.get(index)?.stale ? null : current.get(index)?.value ?? null;
  const mappings = c ? bodyJointMappings(c) : [];
  const revisions = [...current].flatMap(([index, sample]) => {
    const d = c!.descriptors[index];
    if (d.kind !== 11 || d.revision_of == null || sample.stale || !sample.packet || (typeof sample.value !== "number" && typeof sample.value !== "bigint")) return [];
    const format = bindings(sample.subscription.request)[sample.selection].format;
    return [{ group: d.group, target: d.revision_of, timestamp: sample.packet.timestamp, value: BigInt(sample.value), bits: 8 * width(format) }];
  });
  const matchingRevision = (live: number, definition: number) => {
    const liveSample = current.get(live), restSample = current.get(definition);
    if (!liveSample?.packet || liveSample.stale || !restSample?.packet || restSample.stale) return false;
    const target = c!.descriptors[definition].group;
    const a = revisions.find(r => r.group === c!.descriptors[live].group && r.target === target && r.timestamp === liveSample.packet!.timestamp);
    const b = revisions.find(r => r.group === target && r.target === target && r.timestamp === restSample.packet!.timestamp);
    return !!a && !!b && BigInt.asUintN(Math.min(a.bits, b.bits), a.value) === BigInt.asUintN(Math.min(a.bits, b.bits), b.value);
  };
  const outdated = new Set<number>();
  if (c) {
    for (const s of session?.active.values() ?? []) {
      const group = s.request.group, known = session?.revisions.get(group);
      if (!known) continue;
      const selections = bindings(s.request);
      const revision = selections.find(selection => {
        const d = c.descriptors[selection.descriptor]; return d.kind === 11 && d.revision_of === group;
      });
      const value = revision && current.get(revision.descriptor)?.value;
      if (value != null) {
        const bits = 8 * width(revision!.format);
        if (BigInt.asUintN(Math.min(known.bits, bits), known.value) !== BigInt.asUintN(Math.min(known.bits, bits), BigInt(value as number | bigint))) outdated.add(group);
      }
    }
  }
  const located = (index: number, includeStale = false): LocatedPose | undefined => {
    const d = c!.descriptors[index], sample = current.get(index);
    const value = includeStale ? sample?.value : read(index);
    if (!sample || !Array.isArray(value) || outdated.has(d.group)) return;
    const quality = (index: number | null | undefined) => {
      const companion = index == null ? undefined : current.get(index);
      if (!companion || companion.packet?.timestamp !== sample.packet?.timestamp ||
          (companion.stale && !(includeStale && sample.stale))) return;
      return typeof companion.value === "boolean" ? companion.value : undefined;
    };
    const positionValid = d.position_valid_sample == null || quality(d.position_valid_sample) === true;
    const orientationValid = d.orientation_valid_sample == null || quality(d.orientation_valid_sample) === true;
    const positionTracked = quality(d.position_tracked_sample), orientationTracked = quality(d.orientation_tracked_sample);
    const flags = (positionValid ? 2 : 0) | (orientationValid ? 1 : 0) | (positionTracked ? 8 : 0) | (orientationTracked ? 4 : 0);
    const tracking = [positionTracked, orientationTracked];
    // Missing tracking samples (including rest poses) are unknown, not a reported tracking loss.
    const tracked = tracking.includes(false) ? false : tracking.every(v => v === true) ? true : undefined;
    return { positionTracked, orientationTracked, pose: { position: value.slice(0, 3), orientation: value.slice(3), flags, active: flags !== 0, tracked }, space: bindings(sample.subscription.request)[sample.selection].space };
  };
  const skeletonSamples = new Set<number>();
  c?.skeletons.forEach((skeleton, skeletonIndex) => {
    const resolver = (rest: boolean) => {
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
      return resolve;
    };
    const resolve = resolver(rest);
    const offset = body.poses.length;
    skeleton.joints.forEach((joint, i) => {
      skeletonSamples.add(joint.pose_sample); skeletonSamples.add(joint.rest_pose_sample);
      const result = resolve(i);
      body.poses.push(result?.pose ?? missingPose());
      hierarchy.joints.push({ id: offset + i, parent: joint.parent === i ? -1 : offset + joint.parent });
      if (result && result.pose.flags & 2) { spaces.add(result.space); body.active = true; }
    });
    const ids = mappings[skeletonIndex];
    if (ids) {
      mappedSkeletons++;
      // Live skinning combines two acquisitions. Positive agreement is required
      // in both directions, even when the newer rest snapshot is already known.
      // A standalone rest view does not combine live data and needs no live revision.
      if (!rest && !skeleton.joints.every(j => matchingRevision(j.pose_sample, j.rest_pose_sample))) return;
      const resolveRest = rest ? resolve : resolver(true), restSpaces = new Set<number>();
      const joints = skeleton.joints.map((joint, i) => {
        const result = resolveRest(i);
        if (result && (result.pose.flags & 3) === 3) restSpaces.add(result.space);
        return { id: ids[i], parent: joint.parent === i ? -1 : ids[joint.parent], rest: result?.pose ?? missingPose() };
      });
      if (restSpaces.size === 1) bodyMesh = { sample: { active: true, poses: body.poses.slice(offset) }, skeleton: { joints } };
    }
  });
  const references = new Map<number, StandalonePose>();
  const previous = session && lastStandalone.get(session);
  for (const [index, sample] of current) {
    const d = c!.descriptors[index];
    if (d.kind !== 10 || skeletonSamples.has(index) || outdated.has(d.group)) continue;
    const { subscription, selection } = sample;
    const result = located(index, true);
    const space = result?.space ?? bindings(subscription.request)[selection].space;
    if (space === 5) continue;
    const last = previous?.get(index);
    const reference = last?.subscription === subscription && last.space === space ? last : undefined;
    const pose = result?.pose ?? missingPose();
    const display: StandalonePose = { ...pose, subscription, space,
      position: pose.flags & 2 ? pose.position : reference?.position ?? [0, 0, 0],
      orientation: pose.flags & 1 ? pose.orientation : reference?.orientation ?? [0, 0, 0, 1],
      positionTracked: result?.positionTracked, orientationTracked: result?.orientationTracked,
      stale: sample.stale || lateGenerations.has(subscription.generation) };
    const trigger = gripperTriggers.get(d.id);
    if (trigger) {
      const input = descriptorIndices(c!).get(trigger);
      if (input !== undefined && c!.descriptors[input].kind === 8) {
        const closure = controlReading(c!, current, input, lateGenerations).sample?.value;
        if (typeof closure === "number") display.closure = closure;
      }
    }
    references.set(index, display);
    if (!rest) {
      poses.push(display); sources.push(poseSources.get(d.id) ?? d.id); spaces.add(space);
    }
  }
  if (session) lastStandalone.set(session, references);
  const confidenceIndices = new Set(c?.skeletons.flatMap(s => s.joints.flatMap(j => {
    const index = c.descriptors[j.pose_sample].confidence_sample;
    return index == null ? [] : [index];
  })) ?? []);
  const confidences = [...confidenceIndices].flatMap(index => {
    const descriptor = c!.descriptors[index];
    // Operator binding convention; servers without a companion report ordinary confidence.
    const validity = c!.descriptors.findIndex(d => d.id === `${descriptor.id}/valid` && d.kind === 1 && d.formats.includes(1));
    if (validity >= 0 && (c!.descriptors[validity].group !== descriptor.group || read(validity) !== true || current.get(validity)?.packet?.timestamp !== current.get(index)?.packet?.timestamp)) return [];
    const value = read(index);
    return typeof value === "number" ? [value] : [];
  });
  const confidence = confidences.length ? Math.min(...confidences) : undefined;
  const trackedJoints = body.poses.filter(p => (p.flags & 14) === 14).length;
  const mixedSpaces = spaces.size > 1;
  if (mixedSpaces) { poses.length = 0; sources.length = 0; body.active = false; }
  if (mixedSpaces || !body.active || mappedSkeletons !== 1) bodyMesh = undefined;
  return { values: current, poses: { poses }, sources, body, hierarchy, bodyMesh, mixedSpaces, space: spaces.size === 1 ? [...spaces][0] : undefined, outdated, confidence, trackedJoints, rest };
}
export function valueText(value: Value | null) {
  if (value === null) return "Unavailable";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(v => v.toFixed(3)).join(", ");
  return typeof value === "number" && !Number.isInteger(value) ? value.toFixed(4) : String(value);
}
