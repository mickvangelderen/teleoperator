import { operatorOrigin } from "./operator-address";
import type { OperatorEndpoint } from "./operator-address";

const historyKey = "teleoperator.recent-operators";
const selectionKey = "teleoperator.selected-operator";

function savedOperators(): OperatorEndpoint[] {
  try {
    const entries: OperatorEndpoint[] = JSON.parse(localStorage.getItem(historyKey) ?? "[]");
    return entries.filter(entry => typeof entry?.name === "string" && operatorOrigin(entry.address) === entry.address).slice(0, 8);
  } catch { return []; }
}

function tabAddress() {
  try { return operatorOrigin(sessionStorage.getItem(selectionKey) ?? ""); } catch { return ""; }
}

export function healthLabel(data: unknown) {
  if (typeof data === "object" && data !== null) {
    if (("tracking" in data && data.tracking === false) ||
        ("selected" in data && (data.selected === null ||
          (typeof data.selected === "object" && "connected" in data.selected && data.selected.connected === false)))) {
      return "HTTP reachable · input unavailable";
    }
  }
  return "HTTP reachable";
}

export function mountOperatorChooser(select: HTMLSelectElement, target: HTMLInputElement, changed: () => void) {
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const reachability = new Map<string, string>();
  let nearby: OperatorEndpoint[] = [];
  let recent = savedOperators();
  let configured = "";
  target.value = tabAddress();
  let explicit = !!target.value;
  let browsing = "Looking for operators…";
  let lastMenu = "";
  let checking = false;

  function render() {
    const selected = target.value;
    const listed = new Set<string>();
    const options: [string, string, string][] = [];
    function add(group: string, address: string, label: string) {
      if (listed.has(address)) return;
      listed.add(address);
      options.push([group, address, label]);
    }
    for (const [group, entries] of [["Nearby", nearby], ["Previously used", recent]] as const) {
      for (const { address, name } of entries) {
        const status = reachability.get(address);
        const label = name ? `${name} · ${new URL(address).host}` : address;
        add(group, address, status ? `${label} · ${status}` : label);
      }
    }
    if (configured) add("Default", configured, configured);
    const menu = JSON.stringify([options, browsing]);
    if (menu !== lastMenu) {
      const fragment = document.createDocumentFragment();
      const groups = new Map<string, HTMLOptGroupElement>();
      if (!nearby.length) {
        const hint = new Option(browsing);
        hint.disabled = true;
        fragment.append(hint);
      }
      for (const [group, address, label] of options) {
        if (!groups.has(group)) {
          const node = document.createElement("optgroup");
          node.label = group;
          groups.set(group, node);
          fragment.append(node);
        }
        groups.get(group)!.append(new Option(label, address));
      }
      fragment.append(new Option("Enter address…", ""));
      select.replaceChildren(fragment);
      lastMenu = menu;
    }
    select.value = listed.has(selected) ? selected : "";
    select.title = select.selectedOptions[0]?.textContent ?? "";
  }

  function pin() {
    explicit = true;
    try {
      sessionStorage.setItem(selectionKey, operatorOrigin(target.value));
    } catch {
      try { sessionStorage.removeItem(selectionKey); } catch { /* Storage can be unavailable. */ }
    }
  }

  function applyDefault() {
    if (!explicit) target.value = nearby[0]?.address ?? configured;
    render();
  }

  target.addEventListener("input", () => { pin(); render(); changed(); }, { signal });
  select.addEventListener("change", () => {
    target.value = select.value;
    pin();
    render();
    changed();
    if (!target.value) target.focus();
  }, { signal });

  async function discover() {
    try {
      const response = await fetch("/api/operators", { signal });
      if (!response.ok) throw new Error();
      nearby = await response.json();
      browsing = "No nearby operators found";
    } catch {
      nearby = [];
      browsing = "Network discovery unavailable";
    }
    if (!signal.aborted) applyDefault();
  }

  async function checkRecent() {
    if (checking || signal.aborted) return;
    checking = true;
    const entries = recent;
    for (const entry of entries) reachability.set(entry.address, "Checking…");
    render();
    await Promise.all(entries.map(async ({ address }) => {
      let label = "No response";
      try {
        const response = await fetch("/api/health", {
          headers: { "X-Operator-Address": address }, signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
        });
        if (response.headers.has("X-Operator-Response")) {
          label = response.ok ? healthLabel(await response.json().catch(() => null)) : `Health HTTP ${response.status}`;
        }
      } catch { /* A failed or timed-out request leaves reachability unconfirmed. */ }
      reachability.set(address, label);
      if (!signal.aborted) render();
    }));
    checking = false;
  }

  window.addEventListener("storage", event => {
    if (event.key === historyKey || event.key === null) {
      recent = savedOperators();
      void checkRecent();
      render();
    }
  }, { signal });
  void fetch("/api/operator-address", { signal }).then(async response => {
    if (response.ok) configured = operatorOrigin(await response.json());
    if (!signal.aborted) applyDefault();
  }).catch(() => {});
  async function poll(delay: number) {
    if (!document.hidden) await discover();
    if (!signal.aborted) timer = window.setTimeout(() => void poll(5000), delay);
  }
  let timer: number;
  void poll(750);
  void checkRecent();
  const healthTimer = window.setInterval(() => { if (!document.hidden) void checkRecent(); }, 30_000);
  return {
    pin,
    remember(address: string, health?: unknown) {
      const entries = savedOperators();
      const name = nearby.find(item => item.address === address)?.name ?? entries.find(item => item.address === address)?.name ?? "";
      recent = [{ name, address }, ...entries.filter(entry => entry.address !== address)].slice(0, 8);
      try { localStorage.setItem(historyKey, JSON.stringify(recent)); } catch { /* Keep this tab usable. */ }
      if (health !== undefined) reachability.set(address, healthLabel(health));
      render();
    },
    dispose() {
      lifetime.abort();
      clearTimeout(timer);
      clearInterval(healthTimer);
    },
  };
}
