import { Connection, initialState } from "./connection";
import type { State } from "./connection";
import "./style.css";
import type { SpatialView } from "./spatial";
import { profiler, mountPerformancePanel } from "./performance";
import { recording } from "./recording";
import { setAttribute, setText } from "./dom";

declare const __OPERATOR_TARGET__: string;

const icon = (name: "head" | "controller" | "body") => {
  const paths = {
    head: '<path d="M5 8h14l2 4-2 6h-5l-2-2-2 2H5l-2-6z"/><path d="M7 8V6h10v2M7 12h3m4 0h3"/>',
    controller:
      '<path d="M8 10 6 20h4l3-8M9 3c-4 0-6 3-5 6s4 4 8 3 6-4 4-7-4-2-7-2Z"/><path d="M8 7h4m-2-2v4"/>',
    body: '<circle cx="12" cy="5" r="2"/><path d="m5 9 7 2 7-2m-7 2v5m0 0-5 5m5-5 5 5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="XR Operator Viewer home"><span class="brand-mark">×</span><span>XR OPERATOR</span><span class="brand-divider">/</span><strong>Viewer</strong></a>
    <span class="header-note"><span class="mini-dot"></span> DEVICE OBSERVABILITY</span>
  </header>
  <main>
    <section class="page-heading">
      <div><div class="eyebrow">OPERATOR / CONNECTION</div><h1>A window into your device.</h1><p>Protocol migration in progress. Tracking is temporarily unavailable.</p></div>
      <div class="connection-box"><div><label>DEVICE ENDPOINT</label><span id="target" class="mono"></span></div><button id="connect" class="primary">Connect <span aria-hidden="true">↗</span></button></div>
    </section>
    <div id="error" class="error" role="alert" hidden></div>
    <section class="metrics" aria-label="Connection metrics">
      <div class="metric"><label>CONNECTION</label><div><span id="status-dot" class="status-dot"></span><strong id="status" aria-live="polite">Disconnected</strong></div><span id="connection-note">Ready to connect</span></div>
    </section>
    <div class="workspace-layout">
      <section class="panel workspace">
        <div class="panel-header"><h2><span class="panel-symbol">⌘</span> Tracking workspace</h2><span class="tag">WIP</span></div>
        <div class="viewport"><div id="poses"></div><div class="viewport-label"><span class="mini-dot"></span> <span id="data-source">SPATIAL VIEW</span></div><div id="empty-state" class="empty-state"><span class="empty-icon">${icon("head")}</span><h3 id="workspace-title">Tracking unavailable</h3><p id="workspace-note">The tracking protocol is being replaced.</p></div><div class="viewport-footer"><span>+X right &nbsp; +Y up &nbsp; −Z forward</span><span>METRES · RIGHT-HANDED</span></div></div>
        <div class="view-controls"><label>View <select id="view-angle"><option value="iso">Perspective</option><option value="front">Front</option><option value="side">Side</option></select></label><label>Zoom <input id="view-zoom" type="range" min="0.6" max="1.5" step="0.1" value="1"></label><label><input id="show-joints" type="checkbox"> Joint overlay</label><label><input id="continuous-render" type="checkbox" checked> Continuous rendering</label><span id="body-quality">Body tracking unavailable</span><span id="graphics-status" role="status">Loading 3D view…</span></div>
      </section>
      <aside class="panel session">
        <div class="panel-header"><h2>Transport details</h2></div>
        <div class="session-body"><div class="channel"><span class="channel-icon">⇄</span><div><strong>Control</strong><span>Reliable · ordered</span></div><span id="control" class="channel-state">Closed</span></div><div class="channel"><span class="channel-icon">↝</span><div><strong>Tracking</strong><span>Unordered · zero retries</span></div><span id="tracking" class="channel-state">Closed</span></div><div class="session-note"><span>i</span><p id="session-note">Connection setup is available during the migration.</p></div></div>
      </aside>
    </div>
    <section class="panel performance-panel" id="performance" aria-label="Performance profiling"></section>
    <footer><span><span class="footer-mark">×</span> XR Operator <span class="footer-separator">/</span> Viewer</span><span id="footer-status">No device connected</span><span>TRACKING & TRANSPORT <span class="footer-separator">·</span> v0.1</span></footer>
  </main>`;

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const text = (id: string, value: string) => {
  setText(element(id), value);
};
text("target", __OPERATOR_TARGET__);
let connection: Connection | null = null;
let current = initialState();
let spatial: SpatialView | undefined;
let uiDirty = true;
let graphicsStatus = "Loading 3D view…";
let recordingStatus: { message: string; label: string; failed: boolean } | undefined;
const invalidateUI = () => { uiDirty = true; };
const setGraphicsStatus = (message: string) => { graphicsStatus = message; invalidateUI(); };
const animate = (now: number) => {
  frame = requestAnimationFrame(animate);
  if (document.hidden) return;
  profiler.animationFrame(now);
  if (uiDirty) {
    uiDirty = false;
    const started = profiler.begin();
    try { renderState(current); } finally { profiler.end("ui", started); }
  }
  spatial?.renderFrame();
  performancePanel.renderFrame();
};
let frame = requestAnimationFrame(animate);
const performancePanel = mountPerformancePanel(element("performance"));
if (import.meta.env.DEV) {
  recording.start({ type: "session", endpoint: __OPERATOR_TARGET__, viewerVersion: "0.1.0" }, (message, failed) => {
    recordingStatus = { message, failed, label: failed ? "Recording incomplete" : recording.active ? "Recording" : "Saved" };
    invalidateUI();
  });
}
void import("./spatial").then(({ SpatialView }) => {
  spatial = new SpatialView(element("poses"), setGraphicsStatus);
  spatial.setContinuousRendering(element<HTMLInputElement>("continuous-render").checked);
  invalidateUI();
}).catch(() => setGraphicsStatus("WebGL is unavailable."));

function renderState(state: State) {
  text("graphics-status", graphicsStatus);
  if (recordingStatus) {
    const status = element("recording-status");
    setAttribute(status, "hidden", null);
    setText(status, recordingStatus.label);
    setAttribute(status, "title", recordingStatus.message);
    setAttribute(status, "aria-label", recordingStatus.message);
    status.classList.toggle("recording-failed", recordingStatus.failed);
  }
  const live = state.status === "Transport open", busy = state.status === "Connecting";
  text("status", state.status);
  element("status-dot").classList.toggle("live", live);
  element("status-dot").classList.toggle("busy", busy);
  text("connection-note", live ? "Tracking unavailable" : busy ? "Opening data channels" : "Ready to connect");
  text("connect", live ? "Disconnect" : busy ? "Cancel" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  setAttribute(element("error"), "hidden", state.status !== "Error" ? "" : null);
  text("error", state.detail);
  for (const name of ["control", "tracking"] as const) {
    text(name, state[name] === "open" ? "Open" : "Closed");
    element(name).classList.toggle("open", state[name] === "open");
  }
  text("session-note", state.detail);
  text("footer-status", live ? "Transport open · tracking unavailable" : "No device connected");
}

element("connect").onclick = () => {
  if (
    connection &&
    ["Connecting", "Transport open"].includes(connection.state.status)
  ) {
    connection.close();
    connection = null;
    return;
  }
  connection?.close();
  const next = new Connection((state) => {
    if (connection === next) { current = state; invalidateUI(); }
  });
  connection = next;
  void next.connect();
};
window.addEventListener("pagehide", () => { cancelAnimationFrame(frame); connection?.close(); performancePanel.dispose(); void recording.stop("pagehide"); });

for (const id of ["view-angle", "view-zoom"]) element(id).oninput = () => {
  spatial?.setView(element<HTMLSelectElement>("view-angle").value, Number(element<HTMLInputElement>("view-zoom").value));
  invalidateUI();
};

element("continuous-render").onchange = () => {
  const continuous = element<HTMLInputElement>("continuous-render").checked;
  spatial?.setContinuousRendering(continuous);
  recording.add({ type: "render-mode", continuous });
};

element("show-joints").onchange = () => spatial?.showJoints(element<HTMLInputElement>("show-joints").checked);
if (import.meta.hot) import.meta.hot.dispose(() => { cancelAnimationFrame(frame); connection?.close(); spatial?.dispose(); performancePanel.dispose(); void recording.stop("hot-reload"); });
