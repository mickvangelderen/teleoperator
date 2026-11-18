import { ControllerView, mappedControls } from "./controller-view";
import { SampleInspector } from "./sample-inspector";
import { setAttribute, setText } from "./dom";
import type { Capabilities } from "./protocol";
import type { CurrentValue } from "./tracking-view";
import type { Session } from "./session";
import "./visualization.css";

type View = "controller" | "spatial" | "values";
const names: Record<View, string> = { controller: "Controller", spatial: "Spatial", values: "Sample values" };

export class Visualization {
  readonly label = document.createElement("label");
  private readonly select = document.createElement("select");
  private caps?: Capabilities;
  private mapped = new Map<string, number>();
  private poses = new Set<number>();
  private controller?: ControllerView;
  private inspector?: SampleInspector;
  private readonly controllerHost: HTMLElement;
  private readonly inspectorHost: HTMLElement;
  private readonly note: HTMLElement;

  constructor(private readonly workspace: HTMLElement) {
    this.controllerHost = workspace.querySelector("#controller-view")!;
    this.inspectorHost = workspace.querySelector("#sample-inspector")!;
    this.note = workspace.querySelector(".visualization-note")!;
    this.label.className = "visualization-choice";
    this.select.id = "visualization";
    this.select.add(new Option("Automatic", "auto"));
    for (const [value, title] of Object.entries(names)) this.select.add(new Option(title, value));
    this.label.append("Visualization ", this.select);
  }

  update(session: Session | undefined, values: Map<number, CurrentValue>, now: number): View {
    const caps = session?.capabilities;
    if (caps !== this.caps) {
      this.caps = caps;
      this.mapped = caps ? mappedControls(caps) : new Map();
      this.poses = new Set(caps?.descriptors.flatMap((d, i) => d.kind === 10 &&
        (d.spaces.some(s => s !== 5) || caps.skeletons.some(s => s.joints.some(j => j.pose_sample === i || j.rest_pose_sample === i))) ? [i] : []));
      this.controller = undefined; this.inspector = undefined;
      this.controllerHost.replaceChildren(); this.inspectorHost.replaceChildren();
    }
    const manual = this.select.value as View | "auto";
    const automatic = !caps ? "spatial" : [...this.mapped.values()].some(i => values.has(i)) ? "controller"
      : [...this.poses].some(i => values.has(i)) ? "spatial" : "values";
    const compatible = manual === "controller" ? this.mapped.size > 0 : manual === "spatial" ? this.poses.size > 0 : true;
    const view = !caps ? "spatial" : manual === "auto" ? automatic : compatible ? manual : "values";
    setText(this.select.options[0], caps ? "Automatic (" + names[automatic] + ")" : "Automatic");
    const message = caps && manual !== "auto" && !compatible ? names[manual] + " unavailable for this operator. Showing sample values." : "";
    setText(this.note, message); setAttribute(this.note, "hidden", message ? null : "");
    setAttribute(this.workspace, "data-view", view);
    if (view === "controller" && caps) {
      this.controller ??= new ControllerView(this.controllerHost, caps, this.mapped);
      this.controller.update(values, now);
    } else if (this.controller) {
      this.controller = undefined; this.controllerHost.replaceChildren();
    }
    if (view === "values" && session) {
      this.inspector ??= new SampleInspector(this.inspectorHost);
      this.inspector.update(session, now);
    }
    return view;
  }
}
