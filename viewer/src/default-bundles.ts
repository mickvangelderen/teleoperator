import { preferredFormat, type Capabilities, type Selection } from "./protocol";

const gamepadControl = (id: string) =>
  id.startsWith("/user/gamepad/input/") || id.startsWith("/gamepad/input/") || id.startsWith("/gamepad/raw/");

const analogControls = ["trigger_left/value", "trigger_right/value", "thumbstick_left", "thumbstick_right"]
  .map(control => "/user/gamepad/input/" + control);

function inputOrder(id: string): number {
  const control = id.replace(/\/active$/, "");
  // A partially mapped stick may advertise separate x or y samples. Its click is a button.
  const mapped = analogControls.indexOf(control.replace(/\/[xy]$/, ""));
  if (mapped >= 0) return 1 + mapped;
  const axis = /^\/gamepad\/raw\/axis\/(\d+)$/.exec(control);
  return axis ? 1 + analogControls.length + Number(axis[1]) : 0;
}

export function isGamepadGroup(c: Capabilities, group: number) {
  const samples = c.descriptors.filter(d => d.group === group);
  return samples.some(d => d.id === "/gamepad/connected") && samples.some(d => gamepadControl(d.id));
}

export function defaultBundles(c: Capabilities, group: number, rest: boolean): Selection[][] {
  const continuous: Selection[] = [];
  const onChange = new Map<number, Selection[]>();
  const gamepad = isGamepadGroup(c, group);
  c.descriptors.forEach((d, descriptor) => {
    if (d.group !== group) return;
    const selection = { descriptor, format: preferredFormat(d), space: d.spaces[0] ?? 0 };
    const input = gamepad && (gamepadControl(d.id) || d.id === "/gamepad/activity" || d.id === "/gamepad/connected");
    if (!rest && !input) {
      continuous.push(selection);
      return;
    }
    const order = rest ? 0 : inputOrder(d.id);
    const bundle = onChange.get(order);
    if (bundle) bundle.push(selection);
    else onChange.set(order, [selection]);
  });
  const ordered = [...onChange].sort(([a], [b]) => a - b);
  return [continuous, ...ordered.map(([, bundle]) => bundle)];
}
