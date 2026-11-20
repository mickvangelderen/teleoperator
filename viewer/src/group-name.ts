import { restGroup } from "./protocol";
import type { Capabilities } from "./protocol";

export function groupName(c: Capabilities, group: number) {
  if (restGroup(c, group)) return "Rest skeleton";
  const descriptors = c.descriptors.filter(d => d.group === group);
  if (descriptors.some(d => d.id.startsWith("/body/"))) return "Body tracking";
  if (descriptors.some(d => d.kind === 10)) return "Poses";
  if (descriptors.some(d => d.kind >= 2 && d.kind <= 9)) return "Inputs";
  return "Samples";
}

export function groupLabel(c: Capabilities | undefined, group: number) {
  const name = c && groupName(c, group);
  return name && name !== "Samples" ? `${name} · Group ${group}` : `Group ${group}`;
}
