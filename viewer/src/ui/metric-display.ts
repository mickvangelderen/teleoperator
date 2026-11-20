import "./metric-display.css";
import { setSelectableText } from "../dom";
import { formatMeasurement } from "./format";

export class MetricDisplay extends HTMLElement {
  private valueElement?: HTMLElement;

  connectedCallback() {
    if (this.valueElement) return;
    this.classList.add("metric");
    const label = document.createElement("span");
    label.className = "metric-label section-label";
    label.textContent = this.getAttribute("label") ?? "";
    const value = document.createElement("div");
    value.className = "metric-value";
    this.valueElement = document.createElement("strong");
    this.valueElement.id = this.getAttribute("value-id") ?? "";
    this.valueElement.textContent = "—";
    value.append(this.valueElement);
    this.prepend(label, value);
  }

  update(value: number | undefined) {
    this.connectedCallback();
    setSelectableText(this.valueElement!, formatMeasurement(value, this.getAttribute("unit") ?? "", Number(this.getAttribute("precision") ?? 2)));
  }
}
customElements.define("viewer-metric", MetricDisplay);
