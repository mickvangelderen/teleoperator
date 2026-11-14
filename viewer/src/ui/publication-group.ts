import "./publication-group.css";
import { setText } from "../dom";
import { periodic, publicationRate, restGroup, validateRequest } from "../protocol";
import type { Capabilities, Request } from "../protocol";
import type { Subscription } from "../session";
import type { CurrentValue } from "../tracking-view";
import { groupColor } from "./graph-style";
import { SampleSelectionTable } from "./sample-selection-table";

export class PublicationGroup extends HTMLElement {
  readonly samples = new SampleSelectionTable();
  private activeId?: number;
  private publishButton!: HTMLButtonElement;
  private stopButton!: HTMLButtonElement;
  private status!: HTMLElement;

  configure(c: Capabilities, group: number) {
    const max = c.groups[group], delivery = restGroup(c, group) ? 2 : 1;
    this.classList.add("subscription-group");
    this.style.setProperty("--group-color", groupColor(group));
    this.innerHTML = `<div class="publication-controls control-row"><strong class="group-label">Group ${group}</strong><label class="rate-control">Rate <input id="rate-${group}" type="number" min="0.1" max="${max}" step="any" value="${Math.min(max,60)}" aria-label="Group ${group} publication rate"> Hz (max ${max})</label><label>Schedule <select id="schedule-${group}"><option value="periodic" ${restGroup(c, group) ? "" : "selected"}>Periodic</option><option value="onChange" ${restGroup(c, group) ? "selected" : ""}>On change</option></select></label><label class="phase-control">Phase <input id="phase-${group}" type="number" min="0" step="any" value="0"> ms</label><label class="delay-control">Consumption delay <input id="delay-${group}" type="number" min="0" step="any" value="0"> ms</label><label>Delivery <select id="delivery-${group}" aria-label="Group ${group} delivery"><option value="1" ${delivery === 1 ? "selected" : ""}>Unreliable</option><option value="2" ${delivery === 2 ? "selected" : ""}>Reliable</option></select></label><button id="publish-${group}">Apply replacement</button><button id="stop-${group}">Stop publication</button><button class="select-all">Select all</button><button class="select-none">Clear selection</button></div><p id="subscription-${group}" class="subscription-status status-message" role="status"></p>`;
    const input = (name: string) => this.querySelector<HTMLInputElement>(`#${name}-${group}`)!;
    const scheduleSelect = this.querySelector<HTMLSelectElement>(`#schedule-${group}`)!;
    const updateCadence = () => {
      for (const name of ["rate", "phase", "delay"])
        this.querySelector<HTMLElement>(`.${name}-control`)!.hidden = scheduleSelect.value === "onChange";
    };
    scheduleSelect.onchange = updateCadence;
    updateCadence();
    this.samples.configure(c, group);
    this.append(this.samples);
    this.querySelector<HTMLButtonElement>(".select-all")!.onclick = () => this.samples.selectAll(true);
    this.querySelector<HTMLButtonElement>(".select-none")!.onclick = () => this.samples.selectAll(false);
    this.publishButton = this.querySelector<HTMLButtonElement>(`#publish-${group}`)!;
    this.stopButton = this.querySelector<HTMLButtonElement>(`#stop-${group}`)!;
    this.status = this.querySelector(`#subscription-${group}`)!;
    this.publishButton.onclick = () => {
      try {
        const duration = (name: string) => {
          const value = Number(input(name).value) * 1e6;
          if (!Number.isSafeInteger(Math.round(value)) || value < 0) throw new Error("Invalid duration");
          return BigInt(Math.round(value));
        };
        const schedule = scheduleSelect.value === "onChange" ? { kind: "onChange" as const } : periodic(Number(input("rate").value), duration("phase"), duration("delay"));
        const request: Request = { id: group + 1, group, delivery: Number(input("delivery").value), schedule, samples: this.samples.selection };
        validateRequest(c, request);
        this.dispatchEvent(new CustomEvent("publication-request", { bubbles: true, detail: request }));
      } catch (error) {
        this.dispatchEvent(new CustomEvent("publication-error", { bubbles: true, detail: `Selection rejected: ${String(error)}` }));
      }
    };
    this.stopButton.onclick = () => {
      if (this.activeId !== undefined) this.dispatchEvent(new CustomEvent("publication-stop", { bubbles: true, detail: this.activeId }));
    };
  }

  update(active: Subscription | undefined, pending: boolean, values: ReadonlyMap<number, CurrentValue>) {
    this.activeId = active?.request.id;
    this.samples.update(values);
    this.publishButton.disabled = pending;
    this.stopButton.disabled = !active || pending;
    setText(this.publishButton, pending ? "Pending…" : active ? "Apply replacement" : "Start publication");
    setText(this.status, active ? `Subscription ${active.request.id} · ${active.request.samples.length} samples · ${active.request.schedule.kind === "onChange" ? "on change" : `${publicationRate(active.request).toFixed(1)} Hz target`} · ${active.request.delivery === 2 ? "reliable" : "unreliable"} · ${active.packets} packets` : pending ? "Waiting for control response" : "No active publication");
  }
}
customElements.define("publication-group", PublicationGroup);
