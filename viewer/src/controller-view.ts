import { setAttribute, setText } from "./dom";
import type { Capabilities } from "./protocol";
import type { CurrentValue } from "./tracking-view";

const prefix = "/user/gamepad/input/";
const buttonGroups = [
  { title: "Other buttons", className: "pad-buttons", buttons: [
    ["shoulder_left", "Left shoulder"], ["view", "View"], ["menu", "Menu"], ["shoulder_right", "Right shoulder"],
    ["thumbstick_left", "Left stick click"], ["thumbstick_right", "Right stick click"],
  ] },
  { title: "Directional pad", className: "pad-diamond", buttons: [
    ["dpad_left", "Left"], ["dpad_up", "Up"], ["dpad_down", "Down"], ["dpad_right", "Right"],
  ] },
  { title: "Face buttons", className: "pad-diamond", buttons: [
    ["x", "West"], ["y", "North"], ["a", "South"], ["b", "East"],
  ] },
] as const;
const sides = ["left", "right"] as const;
const mappedKinds = new Map<string, number>(buttonGroups.flatMap(group => group.buttons.map(([key]): [string, number] => [prefix + key + "/click", 2])));
for (const side of sides) {
  mappedKinds.set(prefix + "trigger_" + side + "/value", 8);
  mappedKinds.set(prefix + "thumbstick_" + side, 9);
  for (const axis of ["x", "y"]) mappedKinds.set(prefix + "thumbstick_" + side + "/" + axis, 1);
}
export function mappedControls(c: Capabilities) {
  const controls = new Map<string, number>();
  c.descriptors.forEach((d, index) => {
    if (mappedKinds.get(d.id) === d.kind && (d.kind !== 1 || d.formats.some(f => [10, 11, 14, 15].includes(f)))) controls.set(d.id.slice(prefix.length), index);
  });
  return controls;
}

type Reading = { state: string; sample?: CurrentValue };
export class ControllerView {
  private readonly indices: Map<string, number>;
  private readonly refresh: ((read: (path: string) => Reading) => void)[] = [];
  constructor(host: HTMLElement, private readonly caps: Capabilities, readonly controls: Map<string, number>) {
    this.indices = new Map(caps.descriptors.map((d, i) => [d.id, i]));
    const pad = document.createElement("div");
    pad.className = "gamepad";
    host.replaceChildren(pad);
    const section = (name: string, className: string) => {
      const group = document.createElement("section"), heading = document.createElement("h3");
      heading.textContent = name; group.className = className; group.append(heading); pad.append(group);
      return group;
    };
    const triggers = section("Triggers", "pad-pair");
    const sticks = section("Sticks", "pad-pair");
    for (const side of sides) {
      const trigger = document.createElement("div");
      trigger.dataset.control = "trigger_" + side;
      trigger.innerHTML = '<b>' + side + '</b><meter min="0" max="1" aria-label="' + side + ' trigger"></meter><span></span>';
      triggers.append(trigger);
      const meter = trigger.querySelector("meter")!, label = trigger.querySelector("span")!;
      const stick = document.createElement("div");
      stick.dataset.control = "thumbstick_" + side;
      stick.innerHTML = '<b>' + side + '</b><div class="stick-plane" aria-hidden="true"><i hidden></i></div><span></span>';
      const marker = stick.querySelector("i")!, axes = stick.querySelector("span")!;
      sticks.append(stick);
      this.refresh.push(read => {
        const t = read("trigger_" + side + "/value"), v = t.sample?.value;
        meter.hidden = typeof v !== "number";
        if (typeof v === "number") meter.value = v;
        setText(label, typeof v === "number" ? v.toFixed(3) : t.state);
        const path = "thumbstick_" + side, xy = read(path);
        const axis = (key: string, index: number) => {
          if (Array.isArray(xy.sample?.value)) return xy.sample.value[index];
          const single = read(path + "/" + key);
          return typeof single.sample?.value === "number" ? single.sample.value : this.controls.has(path) ? xy.state : single.state;
        };
        const x = axis("x", 0), y = axis("y", 1);
        setText(axes, "X " + (typeof x === "number" ? x.toFixed(3) : x) + " · Y " + (typeof y === "number" ? y.toFixed(3) : y));
        marker.hidden = typeof x !== "number" && typeof y !== "number";
        marker.className = typeof x !== "number" ? "y-only" : typeof y !== "number" ? "x-only" : "";
        const percent = (value: number) => (50 + 46 * Math.max(-1, Math.min(1, value))) + "%";
        marker.style.left = typeof x === "number" ? percent(x) : "50%";
        marker.style.top = typeof y === "number" ? percent(-y) : "50%";
      });
    }
    for (const { title, className, buttons } of buttonGroups) {
      const group = section(title, className);
      for (const [key, label] of buttons) {
        const cell = document.createElement("div"), name = document.createElement("b"), state = document.createElement("span");
        name.textContent = label; cell.dataset.control = key + "/click"; cell.append(name, state);
        group.append(cell);
        const path = key + "/click", index = controls.get(path), descriptor = index === undefined ? undefined : caps.descriptors[index];
        if (descriptor) cell.title = descriptor.name || descriptor.id;
        this.refresh.push(read => {
          const button = read(path), value = button.sample?.value;
          setAttribute(cell, "data-held", value === true ? "" : null);
          setText(state, typeof value === "boolean" ? value ? "Pressed" : "Released" : button.state);
        });
      }
    }
  }

  update(values: Map<number, CurrentValue>) {
    const read = (path: string): Reading => {
      const index = this.controls.get(path);
      if (index === undefined) return { state: "Not advertised" };
      const sample = values.get(index);
      if (!sample) return { state: "Not subscribed" };
      if (!sample.packet) return { state: "Waiting" };
      if (sample.stale) return { state: "Stale" };
      const connected = this.indices.get("/gamepad/connected");
      const device = connected === undefined ? undefined : values.get(connected);
      if (device?.value === false && !device.stale && device.packet && device.packet.timestamp >= sample.packet.timestamp) return { state: "Disconnected" };
      const flag = this.indices.get(prefix + path + "/active");
      if (flag !== undefined && this.caps.descriptors[flag].group === this.caps.descriptors[index].group &&
        this.caps.descriptors[flag].kind === 1 && this.caps.descriptors[flag].formats.includes(1)) {
        const active = values.get(flag);
        if (!active || active.stale || active.packet?.timestamp !== sample.packet.timestamp) return { state: "Activity unknown" };
        if (active.value !== true) return { state: "Inactive" };
      }
      return { state: "", sample };
    };
    for (const refresh of this.refresh) refresh(read);
  }
}
