import { preferredFormat, type Capabilities, type Selection } from "./protocol";

const gamepadControl = (id: string) => id.startsWith("/user/gamepad/input/") || id.startsWith("/gamepad/raw/");

export function isGamepadGroup(c: Capabilities, group: number) {
  const samples = c.descriptors.filter(d => d.group === group);
  return samples.some(d => d.id === "/gamepad/connected") && samples.some(d => gamepadControl(d.id));
}

export function defaultBundles(c: Capabilities, group: number, rest: boolean): Selection[][] {
  const continuous: Selection[] = [], onChange: Selection[] = [];
  const gamepad = isGamepadGroup(c, group);
  c.descriptors.forEach((d, descriptor) => {
    if (d.group !== group) return;
    // Raw controls and their companions share one acquisition when any of them changes.
    const input = gamepad && (gamepadControl(d.id) || d.id === "/gamepad/activity" || d.id === "/gamepad/connected");
    const bundle = rest || input ? onChange : continuous;
    bundle.push({ descriptor, format: preferredFormat(d), space: d.spaces[0] ?? 0 });
  });
  return onChange.length ? [continuous, onChange] : [continuous];
}
