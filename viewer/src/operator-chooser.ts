import { setText } from "./dom";
import { defaultOperatorAddress, operatorOrigin } from "./operator-address";
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

export const operatorPickerMarkup = `
  <dialog id="operator-picker" aria-labelledby="picker-heading">
    <form>
      <div class="picker-heading"><h2 id="picker-heading" tabindex="-1" autofocus>Choose an operator</h2>
        <button type="button" data-close aria-label="Close operator picker">×</button></div>
      <section aria-labelledby="nearby-heading"><h3 id="nearby-heading">Nearby operators</h3>
        <p class="discovery-status" role="status"></p><div class="operator-choices" data-nearby></div></section>
      <section aria-labelledby="saved-heading" hidden><h3 id="saved-heading">Saved operators</h3>
        <div class="operator-choices" data-saved></div></section>
      <div class="picker-address"><label for="target">Operator address</label>
        <input id="target" type="url" class="mono" placeholder="http://host:port" required spellcheck="false" autocomplete="off">
        <button type="button" data-default></button></div>
      <div class="picker-actions"><button class="primary" type="submit">Connect</button></div>
    </form>
  </dialog>`;

export function mountOperatorChooser(dialog: HTMLDialogElement, opener: HTMLButtonElement, changed: () => void) {
  const target = dialog.querySelector<HTMLInputElement>("#target")!;
  const nearbyList = dialog.querySelector<HTMLElement>("[data-nearby]")!;
  const savedList = dialog.querySelector<HTMLElement>("[data-saved]")!;
  const status = dialog.querySelector<HTMLElement>(".discovery-status")!;
  const useDefault = dialog.querySelector<HTMLButtonElement>("[data-default]")!;
  const selected = opener.querySelector<HTMLElement>(".mono")!;
  const reachability = new Map<string, string>();
  const lifetime = new AbortController();
  let session: AbortController | undefined;
  let recent = savedOperators();
  let nearby: OperatorEndpoint[] = [];
  let configured = defaultOperatorAddress;
  target.value = tabAddress();
  let explicit = !!target.value;
  target.value ||= configured;
  let searching = false;
  let unavailable = false;

  function showRows(container: HTMLElement, entries: OperatorEndpoint[]) {
    const remaining = new Map(Array.from(container.querySelectorAll("button"), button => [button.value, button]));
    for (const [index, { address, name }] of entries.entries()) {
      let button = remaining.get(address);
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.value = address;
        button.innerHTML = '<span class="choice-name"></span><span class="choice-address mono"></span><span class="choice-health"></span>';
      }
      remaining.delete(address);
      setText(button.children[0], name || address);
      setText(button.children[1], name ? address : "");
      const health = reachability.get(address);
      setText(button.children[2], health && container === nearbyList ? `Saved · ${health}` : health ?? "");
      button.setAttribute("aria-pressed", String(address === target.value));
      if (container.children[index] !== button) container.insertBefore(button, container.children[index] ?? null);
    }
    for (const button of remaining.values()) button.remove();
  }

  function render() {
    setText(selected, target.value || "Enter address…");
    if (!dialog.open) return;
    const focused = document.activeElement instanceof HTMLButtonElement && document.activeElement.closest(".operator-choices")
      ? document.activeElement.value : undefined;
    const advertised = new Set(nearby.map(endpoint => endpoint.address));
    const saved = recent.filter(endpoint => !advertised.has(endpoint.address));
    showRows(nearbyList, nearby);
    showRows(savedList, saved);
    savedList.parentElement!.hidden = !saved.length;
    setText(useDefault, `Use default · ${configured}`);
    useDefault.hidden = configured === target.value;
    const busy = searching && !unavailable && !nearby.length;
    status.classList.toggle("searching", busy);
    status.classList.toggle("has-results", nearby.length > 0);
    setText(status, unavailable ? "Network discovery unavailable" : busy ? "Searching the local network…" :
      nearby.length ? `${nearby.length} nearby operator${nearby.length === 1 ? "" : "s"}` : "No nearby operators found");
    if (focused && !dialog.contains(document.activeElement)) {
      const rows = dialog.querySelectorAll<HTMLButtonElement>(".operator-choices button");
      const replacement = Array.from(rows).find(row => row.value === focused);
      (replacement ?? target).focus();
    }
  }

  function pin() {
    explicit = true;
    try {
      sessionStorage.setItem(selectionKey, operatorOrigin(target.value));
    } catch {
      try { sessionStorage.removeItem(selectionKey); } catch { /* Storage can be unavailable. */ }
    }
    render();
  }

  function applySuggestion() {
    if (!explicit && !nearby.some(endpoint => endpoint.address === target.value)) {
      target.value = nearby[0]?.address ?? configured;
    }
    render();
  }

  function choose(address: string) {
    target.value = address;
    pin();
    changed();
  }
  target.oninput = () => { pin(); changed(); };
  dialog.addEventListener("focusin", event => {
    if (event.target === target || (event.target instanceof HTMLElement && event.target.closest(".operator-choices, [data-default]"))) explicit = true;
  });
  dialog.addEventListener("click", event => {
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".operator-choices button") : null;
    if (row) choose(row.value);
  });
  useDefault.onclick = () => { choose(configured); target.focus(); };

  async function checkHealth(address: string, signal: AbortSignal) {
    let label = "No response";
    try {
      const response = await fetch("/api/health", {
        headers: { "X-Operator-Address": address }, signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
      });
      if (response.headers.has("X-Operator-Response")) {
        label = response.ok ? healthLabel(await response.json().catch(() => null)) : `Health HTTP ${response.status}`;
      }
    } catch { /* A failed or timed-out request leaves reachability unconfirmed. */ }
    if (signal.aborted) return;
    reachability.set(address, label);
    render();
  }

  function open() {
    if (dialog.open || opener.disabled) return;
    session = new AbortController();
    const { signal } = session;
    nearby = [];
    searching = true;
    unavailable = false;
    recent = savedOperators();
    reachability.clear();
    dialog.showModal();
    let checks: AbortController | undefined;
    function checkSaved() {
      checks?.abort();
      checks = new AbortController();
      const checkSignal = AbortSignal.any([signal, checks.signal]);
      for (const { address } of recent) {
        reachability.set(address, "Checking…");
        void checkHealth(address, checkSignal);
      }
      render();
    }
    checkSaved();
    window.addEventListener("storage", event => {
      if (!event.key || event.key === historyKey) {
        recent = savedOperators();
        reachability.clear();
        checkSaved();
      }
    }, { signal });
    const healthTimer = window.setInterval(() => { if (!document.hidden) checkSaved(); }, 30_000);
    let receivedSnapshot = false;
    const searchTimer = window.setTimeout(() => {
      searching = false;
      if (!receivedSnapshot) unavailable = true;
      render();
    }, 2200);
    const stream = new EventSource("/api/operators");
    stream.onmessage = event => {
      if (signal.aborted) return;
      const endpoints: OperatorEndpoint[] | null = JSON.parse(event.data);
      receivedSnapshot = true;
      unavailable = endpoints === null;
      const previouslyNearby = new Set(nearby.map(endpoint => endpoint.address));
      nearby = endpoints ?? [];
      if (recent.some(entry => previouslyNearby.has(entry.address) !== nearby.some(endpoint => endpoint.address === entry.address))) {
        checkSaved();
      }
      if (nearby.length || unavailable) searching = false;
      applySuggestion();
    };
    stream.onerror = () => {
      if (signal.aborted) return;
      searching = false; unavailable = true; nearby = [];
      applySuggestion();
    };
    signal.addEventListener("abort", () => {
      stream.close();
      clearTimeout(searchTimer);
      clearInterval(healthTimer);
    }, { once: true });
  }

  function close(focus = opener) {
    if (!dialog.open) return;
    session?.abort();
    dialog.close();
    focus.focus();
  }
  opener.onclick = open;
  dialog.querySelector<HTMLButtonElement>("[data-close]")!.onclick = () => close();
  dialog.oncancel = event => { event.preventDefault(); close(); };
  void fetch("/api/operator-address", { signal: lifetime.signal }).then(async response => {
    if (response.ok) configured = operatorOrigin(await response.json());
    applySuggestion();
  }).catch(() => {});
  render();
  open();
  return {
    open, close, pin,
    remember(address: string) {
      const entries = savedOperators();
      const name = nearby.find(item => item.address === address)?.name ?? entries.find(item => item.address === address)?.name ?? "";
      recent = [{ name, address }, ...entries.filter(entry => entry.address !== address)].slice(0, 8);
      try { localStorage.setItem(historyKey, JSON.stringify(recent)); } catch { /* Keep this tab usable. */ }
    },
    dispose() { session?.abort(); lifetime.abort(); if (dialog.open) dialog.close(); },
  };
}
