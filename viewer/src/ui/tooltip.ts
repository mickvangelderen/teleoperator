import "./tooltip.css";
let nextId = 0;

// Light DOM keeps the trigger's native focus behavior and ARIA relationship intact.
export class ViewerTooltip extends HTMLElement {
  readonly content = document.createElement("div");
  private hovered = false;
  private focused = false;
  private dismissed = false;
  private focusIn = () => { this.focused = true; this.refresh(); };
  private focusOut = (event: FocusEvent) => {
    this.focused = event.relatedTarget instanceof Node && this.contains(event.relatedTarget);
    this.refresh();
  };

  configure(trigger: Element, description: string, id = `viewer-tooltip-${++nextId}`) {
    this.classList.add("tooltip");
    this.content.id = id;
    this.content.className = "tooltip-content";
    this.content.setAttribute("role", "tooltip");
    this.content.textContent = description;
    const describedBy = new Set((trigger.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean));
    describedBy.add(id);
    trigger.setAttribute("aria-describedby", [...describedBy].join(" "));
    this.replaceChildren(trigger, this.content);
    this.onpointerenter = () => { this.hovered = true; this.refresh(); };
    this.onpointerleave = () => { this.hovered = false; this.refresh(); };
    this.addEventListener("focusin", this.focusIn);
    this.addEventListener("focusout", this.focusOut);
    this.onkeydown = event => {
      if (event.key === "Escape") { this.dismissed = true; this.refresh(); }
    };
    this.refresh();
  }

  disconnectedCallback() {
    this.hovered = this.focused = this.dismissed = false;
    this.refresh();
  }

  private refresh() {
    if (!this.hovered && !this.focused) this.dismissed = false;
    this.content.hidden = this.dismissed || !(this.hovered || this.focused);
  }
}
customElements.define("viewer-tooltip", ViewerTooltip);
