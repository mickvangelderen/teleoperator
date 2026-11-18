import "./publication-group.css";
import { setText } from "../dom";
import { timing, bindings, changedOnly, publicationRate, restGroup, validateRequest } from "../protocol";
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
  private automatic!: HTMLInputElement;
  private rate!: HTMLInputElement;
  private phase!: HTMLInputElement;
  private delay!: HTMLInputElement;

  configure(c: Capabilities, group: number) {
    const max = c.groups[group], delivery = restGroup(c, group) ? 2 : 1;
    this.classList.add("subscription-group");
    this.style.setProperty("--group-color", groupColor(group));
    this.innerHTML = `<div class="publication-controls control-row"><strong class="group-label">Group ${group}</strong><label class="rate-control">Rate <input id="rate-${group}" type="number" min="0.1" step="any" value="${Math.min(max,60)}" title="Publication limit; source acquisition rate is ${max} Hz" aria-label="Group ${group} publication rate"> Hz</label><label>Values <select id="schedule-${group}"><option value="continuous" ${restGroup(c, group) ? "" : "selected"}>Every slot</option><option value="onChange" ${restGroup(c, group) ? "selected" : ""}>On change</option></select></label><label class="timing-control"><input id="automatic-${group}" type="checkbox" ${restGroup(c, group) ? "" : "checked"}> Align to display</label><label class="phase-control">Phase <input id="phase-${group}" type="number" min="0" step="any" value="0"> ms</label><label class="delay-control">Prediction offset <input id="delay-${group}" type="number" min="0" step="any" value="0"> ms</label><label>Delivery <select id="delivery-${group}" aria-label="Group ${group} delivery"><option value="1" ${delivery === 1 ? "selected" : ""}>Unreliable</option><option value="2" ${delivery === 2 ? "selected" : ""}>Reliable</option></select></label><button id="publish-${group}">Apply replacement</button><button id="stop-${group}">Stop publication</button><button class="select-all">Select all</button><button class="select-none">Clear selection</button></div><p id="subscription-${group}" class="subscription-status status-message" role="status"></p>`;
    const input = (name: string) => this.querySelector<HTMLInputElement>(`#${name}-${group}`)!;
    this.automatic = input("automatic"); this.rate = input("rate"); this.phase = input("phase"); this.delay = input("delay");
    const scheduleSelect = this.querySelector<HTMLSelectElement>(`#schedule-${group}`)!;
    this.automatic.onchange = () => { this.rate.readOnly = this.phase.readOnly = this.delay.readOnly = this.automatic.checked; };
    this.rate.readOnly = this.phase.readOnly = this.delay.readOnly = this.automatic.checked;
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
        const schedule = timing(Number(input("rate").value), this.automatic.checked ? 0n : duration("phase"), this.automatic.checked ? 0n : duration("delay"));
        const request: Request = { id: group + 1, group, delivery: Number(input("delivery").value), ...schedule, sequenceNumberFormat: scheduleSelect.value === "onChange" ? 2 : null, bundles: scheduleSelect.value === "onChange" ? [[], this.samples.selection] : [this.samples.selection] };
        validateRequest(c, request);
        this.dispatchEvent(new CustomEvent("publication-request", { bubbles: true, detail: { ...request, automaticTiming: this.automatic.checked } }));
      } catch (error) {
        this.dispatchEvent(new CustomEvent("publication-error", { bubbles: true, detail: `Selection rejected: ${String(error)}` }));
      }
    };
    this.stopButton.onclick = () => {
      if (this.activeId !== undefined) this.dispatchEvent(new CustomEvent("publication-stop", { bubbles: true, detail: this.activeId }));
    };
  }

  update(active: Subscription | undefined, pending: boolean, values: ReadonlyMap<number, CurrentValue>, automaticTiming = false) {
    this.activeId = active?.request.id;
    this.samples.update(values);
    if (this.automatic.checked && automaticTiming && active) {
      this.rate.value = publicationRate(active.request).toFixed(1);
      this.phase.value = (Number(active.request.phase) / 1e6).toFixed(3);
      this.delay.value = (Number(active.request.predictionOffset) / 1e6).toFixed(3);
    }
    this.publishButton.disabled = pending;
    this.stopButton.disabled = !active || pending;
    setText(this.publishButton, pending ? "Pending…" : active ? "Apply replacement" : "Start publication");
    setText(this.status, active ? `Subscription ${active.request.id} · ${bindings(active.request).length} samples · ${changedOnly(active.request) ? `on change · ${publicationRate(active.request).toFixed(1)} Hz slots` : `${publicationRate(active.request).toFixed(1)} Hz target`} · ${active.request.delivery === 2 ? "reliable" : "unreliable"} · ${active.packets} packets` : pending ? "Waiting for control response" : "No active publication");
  }
}
customElements.define("publication-group", PublicationGroup);
