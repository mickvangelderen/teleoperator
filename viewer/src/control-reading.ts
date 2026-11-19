import type { Capabilities } from "./protocol";
import type { CurrentValue } from "./tracking-view";

const indices = new WeakMap<Capabilities, Map<string, number>>();
export function descriptorIndices(caps: Capabilities) {
  let result = indices.get(caps);
  if (!result) {
    result = new Map(caps.descriptors.map((d, i) => [d.id, i]));
    if (Object.isFrozen(caps)) indices.set(caps, result);
  }
  return result;
}

export type Reading = { state: string; sample?: CurrentValue };
export function controlReading(caps: Capabilities, values: Map<number, CurrentValue>, index?: number, late?: ReadonlySet<number>): Reading {
  if (index === undefined) return { state: "Not advertised" };
  const sample = values.get(index);
  if (!sample) return { state: "Not subscribed" };
  if (!sample.packet) return { state: "Waiting" };
  if (sample.stale || late?.has(sample.subscription.generation)) return { state: "Stale" };
  const ids = descriptorIndices(caps), descriptor = caps.descriptors[index];
  if (descriptor.id.startsWith("/user/gamepad/input/")) {
    const connected = ids.get("/gamepad/connected");
    const device = connected === undefined ? undefined : values.get(connected);
    if (device?.value === false && !device.stale && device.packet && device.packet.timestamp >= sample.packet.timestamp) return { state: "Disconnected" };
  }
  const flag = ids.get(descriptor.id + "/active");
  if (flag !== undefined && caps.descriptors[flag].group === descriptor.group &&
      caps.descriptors[flag].kind === 1 && caps.descriptors[flag].formats.includes(1)) {
    const active = values.get(flag);
    if (!active || active.stale || late?.has(active.subscription.generation) || active.packet?.timestamp !== sample.packet.timestamp) return { state: "Activity unknown" };
    if (active.value !== true) return { state: "Inactive" };
  }
  return { state: "", sample };
}
