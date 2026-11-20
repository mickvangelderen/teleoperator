import "./tooltip.css";
let nextId = 0;

// A widget can own interaction while this element owns its plot and tooltip.
export class ViewerTooltip extends HTMLElement {
  readonly content = document.createElement("div");
  private scope: HTMLElement = this;
  private listening = false;
  private hovered = false;
  private focused = false;
  private dismissed = false;
  private pointerIn = () => { this.hovered = true; this.refresh(); };
  private pointerOut = () => { this.hovered = false; this.refresh(); };
  private focusIn = () => { this.focused = true; this.refresh(); };
  private focusOut = (event: FocusEvent) => {
    this.focused = event.relatedTarget instanceof Node && this.scope.contains(event.relatedTarget);
    this.refresh();
  };
  private keyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { this.dismissed = true; this.refresh(); }
  };

  configure(trigger: Element, description: string, id = `viewer-tooltip-${++nextId}`, scope: HTMLElement = this) {
    this.listen(false);
    this.scope = scope;
    this.classList.add("tooltip");
    this.content.id = id;
    this.content.className = "tooltip-content";
    this.content.setAttribute("role", "tooltip");
    this.content.textContent = description;
    const owner = scope === this ? trigger : scope;
    const describedBy = new Set((owner.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    describedBy.add(id);
    owner.setAttribute("aria-describedby", [...describedBy].join(" "));
    this.replaceChildren(trigger, this.content);
    this.listen(true);
    this.refresh();
  }

  connectedCallback() { this.listen(true); }
  disconnectedCallback() {
    this.listen(false);
    this.hovered = this.focused = this.dismissed = false;
    this.refresh();
  }

  private listen(enabled: boolean) {
    if (this.listening === enabled) return;
    this.listening = enabled;
    if (enabled) {
      this.scope.addEventListener("pointerenter", this.pointerIn);
      this.scope.addEventListener("pointerleave", this.pointerOut);
      this.scope.addEventListener("focusin", this.focusIn);
      this.scope.addEventListener("focusout", this.focusOut);
      this.scope.addEventListener("keydown", this.keyDown);
    } else {
      this.scope.removeEventListener("pointerenter", this.pointerIn);
      this.scope.removeEventListener("pointerleave", this.pointerOut);
      this.scope.removeEventListener("focusin", this.focusIn);
      this.scope.removeEventListener("focusout", this.focusOut);
      this.scope.removeEventListener("keydown", this.keyDown);
    }
  }

  private refresh() {
    if (!this.hovered && !this.focused) this.dismissed = false;
    this.content.hidden = this.dismissed || !(this.hovered || this.focused);
  }
}
customElements.define("viewer-tooltip", ViewerTooltip);
