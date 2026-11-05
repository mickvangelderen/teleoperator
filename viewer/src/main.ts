import { Connection, initialState, initialStatistics } from "./connection";
import type { Entry, State } from "./connection";
import { DEFAULT_HISTORY, DEFAULT_SEND_RATE, json } from "./protocol";
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
      <div><div class="eyebrow">OPERATOR / CONNECTION</div><h1>A window into your device.</h1><p>Inspect the connection, discover sources, and follow received data.</p></div>
      <div class="connection-box"><div><label>DEVICE ENDPOINT</label><span id="target" class="mono"></span></div><button id="connect" class="primary">Connect <span aria-hidden="true">↗</span></button></div>
    </section>
    <div id="error" class="error" role="alert" hidden></div>
    <section class="metrics" aria-label="Connection metrics">
      <div class="metric"><label>CONNECTION</label><div><span id="status-dot" class="status-dot"></span><strong id="status" aria-live="polite">Disconnected</strong></div><span id="connection-note">Ready to connect</span></div>
      <div class="metric"><label>PROTOCOL VERSION</label><div><strong id="version">—</strong><span class="metric-unit">XROP</span></div><span>FlatBuffers · binary messages</span></div>
      <div class="metric"><label>ROUND-TRIP TIME</label><div><strong id="rtt">—</strong><span class="metric-unit">ms</span><svg id="sparkline" viewBox="0 0 100 28" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.5"/></svg></div><span>Measured on the tracking channel</span></div>
      <div class="metric"><label>RECEIVED</label><div><strong id="received">0</strong><span class="metric-unit">messages</span></div><span id="received-bytes">0 bytes this connection</span></div>
    </section>
    <div class="workspace-layout">
      <section class="panel workspace">
        <div class="panel-header"><h2><span class="panel-symbol">⌘</span> Tracking workspace</h2><span id="stream-count" class="tag">0 active streams</span></div>
        <div class="viewport"><div id="poses"></div><div class="viewport-label"><span class="mini-dot"></span> <span id="data-source">SPATIAL VIEW</span></div><div id="empty-state" class="empty-state"><span class="empty-icon">${icon("head")}</span><h3 id="workspace-title">Your workspace is ready</h3><p id="workspace-note">Connect to discover the device’s tracking sources.</p></div><div class="viewport-footer"><span>+X right &nbsp; +Y up &nbsp; −Z forward</span><span>METRES · RIGHT-HANDED</span></div></div>
        <div class="view-controls"><label>View <select id="view-angle"><option value="iso">Perspective</option><option value="front">Front</option><option value="side">Side</option></select></label><label>Zoom <input id="view-zoom" type="range" min="0.6" max="1.5" step="0.1" value="1"></label><label><input id="show-joints" type="checkbox"> Joint overlay</label><label><input id="continuous-render" type="checkbox" checked> Continuous rendering</label><span id="body-quality">Body tracking unavailable</span><span id="graphics-status" role="status">Loading 3D view…</span></div><div class="sources" aria-label="Tracking capabilities">${(["head", "controller", "body"] as const).map((type, index) => `<div class="source">${icon(type)}<div><strong>${["Head & poses", "Controller inputs", "Body tracking"][index]}</strong><span class="source-state">Awaiting discovery</span></div><span class="source-dash">—</span></div>`).join("")}</div>
      </section>
      <aside class="panel session">
        <div class="panel-header"><h2>Session details</h2><span id="hello-badge" class="tag">Awaiting hello</span></div>
        <div class="session-body"><label>SERVER SESSION ID</label><code id="session-id">No session established</code><dl><div><dt>Handshake</dt><dd id="handshake">Pending</dd></div><div><dt>Supported versions</dt><dd id="versions">—</dd></div><div><dt>Tracking sources</dt><dd id="source-count">—</dd></div></dl><div class="section-label">DATA CHANNELS</div><div class="channel"><span class="channel-icon">⇄</span><div><strong>Control</strong><span>Reliable · ordered</span></div><span id="control" class="channel-state">Closed</span></div><div class="channel"><span class="channel-icon">↝</span><div><strong>Tracking</strong><span>Unordered · zero retries</span></div><span id="tracking" class="channel-state">Closed</span></div><div class="session-note"><span>i</span><p id="session-note">Each connection negotiates a version and a device session before discovery.</p></div></div>
      </aside>
    </div>
    <section class="panel performance-panel" id="performance" aria-label="Performance profiling"></section>
    <section class="panel controller-panel"><div class="panel-header"><h2>Controller inputs</h2><span id="input-status" class="tag">Awaiting sources</span></div><div id="input-values" class="input-values"></div></section>
    <section class="panel tracking-stats" aria-label="Tracking statistics">
      <div class="panel-header"><h2>Tracking statistics</h2><span id="freshness" class="tag">Awaiting samples</span></div>
      <div class="tracking-controls"><label>Stream <select id="stream-kind"><option value="pose">Poses</option><option value="controller">Controller inputs</option><option value="body">Body</option></select></label><label>Publication <select id="send-rate"><option value="200">200 Hz</option><option value="100" selected>100 Hz</option><option value="30">30 Hz</option><option value="10">10 Hz</option></select></label><label>History <select id="history"><option value="1">1 sample</option><option value="2" selected>2 samples</option><option value="4">4 samples</option><option value="8">8 samples</option></select></label><label>Viewer consumer <select id="consumer-rate"><option value="animation">Display frame rate</option><option value="30">30 Hz</option><option value="60">60 Hz</option><option value="5">5 Hz · slow consumer</option></select></label><button id="inspect-sample">Inspect latest sample</button></div>
      <dl class="tracking-numbers"><div><dt>Received rate</dt><dd id="tracking-rate">—</dd></div><div><dt>Missing messages</dt><dd id="missing">0</dd></div><div><dt>Reordered / duplicates</dt><dd id="reordered">0 / 0</dd></div><div><dt>Samples not received</dt><dd id="sample-gaps">0</dd></div><div><dt>Viewer coalesced</dt><dd id="coalesced">0</dd></div><div><dt>Estimated sample age</dt><dd id="sample-age">—</dd></div><div><dt>Invalid / metadata discards</dt><dd id="discarded">0 / 0</dd></div><div><dt>Too late for reorder window</dt><dd id="too-late">0</dd></div></dl>
      <p class="statistics-note">Missing messages are sequence gaps and may arrive late. Sample gaps also include publication rate limits. Viewer coalescing deliberately replaces pending updates with the latest sample. Age uses an approximate clock mapping.</p>
      <div id="pose-values" class="pose-values"></div>
    </section>
    <section class="panel messages">
      <div class="panel-header"><h2>Message inspector <span id="message-count" class="count">0</span></h2><label class="checkbox"><input type="checkbox" id="show-probes"> Show clock probes</label></div>
      <div class="inspector-layout"><div class="message-list"><table><thead><tr><th>TIME</th><th>MESSAGE</th><th>CHANNEL</th><th class="right">SIZE</th></tr></thead><tbody id="message-rows"></tbody></table><p id="messages-empty">Received messages will appear here.</p></div><div class="payload"><div class="payload-heading"><span id="payload-title">DECODED PAYLOAD</span><span class="tag">FlatBuffers</span></div><pre id="payload">Select a message to inspect its fields.</pre></div></div>
    </section>
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
let selected: Entry | null = null;
let lastRtt: number | null = null;
const rtts: number[] = [];
let messageSignature = "";
let displayedEntry: Entry | null | undefined;
let spatial: SpatialView | undefined;
let uiDirty = true;
let resetControls = false;
let selectPublication = false;
let graphicsStatus = "Loading 3D view…";
let recordingStatus: { message: string; label: string; failed: boolean } | undefined;
const emptyStatistics = initialStatistics();
const poseRows: HTMLDivElement[] = [];
const inputRows: { row: HTMLDivElement; label: HTMLElement; value: HTMLSpanElement; counts: HTMLElement }[] = [];
const invalidateUI = () => { uiDirty = true; };
const setGraphicsStatus = (message: string) => { graphicsStatus = message; invalidateUI(); };
const animate = (now: number) => {
  frame = requestAnimationFrame(animate);
  if (document.hidden) return;
  profiler.animationFrame(now);
  connection?.animationFrame();
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
  recording.start({ type: "session", endpoint: __OPERATOR_TARGET__, viewerVersion: "0.1.0", protocolVersion: 1 }, (message, failed) => {
    recordingStatus = { message, failed, label: failed ? "Recording incomplete" : recording.active ? "Recording" : "Saved" };
    invalidateUI();
  });
}
void import("./spatial").then(({ SpatialView }) => {
  spatial = new SpatialView(element("poses"), setGraphicsStatus);
  spatial.setContinuousRendering(element<HTMLInputElement>("continuous-render").checked);
  invalidateUI();
}).catch(() => setGraphicsStatus("WebGL is unavailable. Tracking data remains available below."));

function updateMessages(state: State) {
  const showProbes = element<HTMLInputElement>("show-probes").checked;
  const entries = state.entries.filter(
    (entry) => showProbes || entry.channel === "control",
  );
  if (!selected)
    selected =
      entries.find((entry) => entry.kind === "ServerHello") ??
      entries[0] ??
      null;
  text("message-count", `${state.received + state.sent}`);
  const tbody = element("message-rows");
  const signature = `${entries.map((entry) => entry.id).join(",")}:${entries[0]?.at.getTime()}`;
  if (signature !== messageSignature) {
    messageSignature = signature;
    setAttribute(element("messages-empty"), "hidden", entries.length ? "" : null);
    tbody.replaceChildren();
    for (const entry of entries.toReversed()) {
      const row = document.createElement("tr");
      const time = document.createElement("td");
      time.className = "mono";
      time.textContent = entry.at.toLocaleTimeString("en-GB", { hour12: false });
      const message = document.createElement("td");
      const button = document.createElement("button");
      button.className = "message-button";
      button.textContent = `${entry.direction === "Received" ? "↓" : "↑"}  ${entry.kind}`;
      button.setAttribute("aria-label", `Inspect ${entry.kind} ${entry.id}`);
      button.onclick = () => {
        selected = entry;
        invalidateUI();
      };
      message.append(button);
      const channel = document.createElement("td");
      channel.textContent = entry.channel;
      const bytes = document.createElement("td");
      bytes.className = "right mono";
      bytes.textContent = `${entry.bytes} B`;
      row.append(time, message, channel, bytes);
      tbody.append(row);
    }
  }
  for (let i = 0; i < entries.length; i++) tbody.children[i].classList.toggle("selected", entries[entries.length - 1 - i] === selected);
  if (displayedEntry === selected) return;
  displayedEntry = selected;
  text(
    "payload-title",
    selected
      ? `${selected.direction.toUpperCase()} / ${selected.kind}`
      : "DECODED PAYLOAD",
  );
  text(
    "payload",
    selected ? json(selected.value) : "Select a message to inspect its fields.",
  );
}

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
  if (resetControls) {
    resetControls = false;
    element<HTMLSelectElement>("send-rate").value = String(DEFAULT_SEND_RATE);
    element<HTMLSelectElement>("history").value = String(DEFAULT_HISTORY);
    element<HTMLSelectElement>("consumer-rate").value = "animation";
  }
  const poseStream = state.streams.find(s => s.descriptor.type === "pose");
  const bodyStream = state.streams.find(s => s.descriptor.type === "body");
  const inputStream = state.streams.find(s => s.descriptor.type === "controller");
  const selectedStream = state.streams.find(s => s.descriptor.type === element<HTMLSelectElement>("stream-kind").value);
  if (selectPublication) {
    selectPublication = false;
    if (selectedStream) {
      element<HTMLSelectElement>("send-rate").value = String(selectedStream.descriptor.rate);
      element<HTMLSelectElement>("history").value = String(selectedStream.descriptor.history);
    }
  }
  const sample = poseStream?.sample ?? null;
  const stream = poseStream?.descriptor ?? null;
  const live = state.status === "Connected",
    busy = state.status === "Connecting";
  text("status", state.status);
  element("status-dot").classList.toggle("live", live);
  element("status-dot").classList.toggle("busy", busy);
  text(
    "connection-note",
    live
      ? "Both data channels open"
      : busy
        ? "Negotiating with device"
        : "Ready to connect",
  );
  text("version", state.hello ? String(state.hello.selectedVersion) : "—");
  text("rtt", state.rtt === null ? "—" : state.rtt.toFixed(1));
  if (state.rtt !== null && state.rtt !== lastRtt) {
    rtts.push(state.rtt);
    if (rtts.length > 25) rtts.shift();
    lastRtt = state.rtt;
  }
  const ceiling = Math.max(10, ...rtts);
  setAttribute(
    element("sparkline").querySelector("polyline")!,
    "points",
    live
      ? rtts.map((rtt, i) => `${i * 4},${26 - (rtt / ceiling) * 22}`).join(" ")
      : "",
  );
  text("received", state.received.toLocaleString());
  text(
    "received-bytes",
    `${state.bytes.toLocaleString()} bytes this connection`,
  );
  text("connect", live ? "Disconnect" : busy ? "Cancel" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  setAttribute(element("error"), "hidden", state.status !== "Error" ? "" : null);
  text("error", state.detail);
  text(
    "workspace-title",
    live ? (stream ? "Waiting for valid poses" : "Waiting for tracking sources") : "Your workspace is ready",
  );
  text(
    "workspace-note",
    live
      ? stream ? "Invalid or inactive poses are hidden until tracking resumes." : "The device is connected. Tracking is currently unavailable."
      : "Connect to discover the device’s tracking sources.",
  );
  const names = state.capabilities?.pose ? state.capabilities.pose.sources : [];
  document.querySelectorAll(".source-state").forEach((source, i) => setText(source, i === 0 && names.length ? `${names.length} pose sources · ${state.capabilities?.sampleRate ?? "—"} Hz` : i === 1 && inputStream ? `${inputStream.descriptor.inputs.length} inputs · ${state.capabilities?.sampleRate} Hz` : i === 2 && bodyStream ? `${bodyStream.sample?.poses.length ?? 0} joints · ${state.capabilities?.sampleRate} Hz` : live ? "Not advertised" : "Awaiting discovery"));
  text("stream-count", `${state.streams.length} active streams`);
  const base = state.capabilities?.spaces.find(s => s.id === stream?.reference?.id);
  const frameName = base ? ["VIEW", "LOCAL", "STAGE", "LOCAL FLOOR", "UNBOUNDED"][base.spaceKind] : "UNKNOWN";
  text("data-source", !live ? "SPATIAL VIEW" : state.source === "synthetic" ? "SYNTHETIC TEST SOURCE" : state.source === "openxr" ? `OPENXR · ${frameName} SPACE` : "SOURCE UNAVAILABLE");
  for (const id of ["send-rate", "history"]) setAttribute(element(id), "disabled", selectedStream ? null : "");
  const stats = selectedStream?.statistics ?? emptyStatistics;
  text("tracking-rate", `${stats.rate.toFixed(1)} Hz`);
  text("missing", String(stats.messages.missing));
  text("reordered", `${stats.messages.reordered} / ${stats.messages.duplicates}`);
  text("sample-gaps", String(stats.samples.missing));
  text("coalesced", String(stats.consumer.coalesced));
  text("discarded", `${state.discarded} / ${stats.discarded}`);
  text("too-late", String(stats.messages.tooLate));
  text("sample-age", stats.age === null ? "—" : `${Math.max(0, stats.age).toFixed(1)} ms`);
  text("freshness", stats.stale ? "Stale / awaiting samples" : "Receiving samples");
  setAttribute(element("empty-state"), "hidden", sample?.poses.some(p => (p.flags & 2) && p.active !== false) || bodyStream?.sample?.body?.active ? "" : null);
  const body = bodyStream?.sample?.body;
  const skeleton = body ? state.skeletons.get(`${bodyStream?.descriptor.skeleton?.id}:${body.skeletonVersion}`) : undefined;
  spatial?.update(sample, stream?.sources ?? [], poseStream?.statistics.stale ?? true, bodyStream?.sample ?? null, skeleton, bodyStream?.statistics.stale ?? true);
  text("body-quality", body ? `${body.active ? "Body active" : "Body inactive"} · confidence ${body.confidence === null ? "unknown" : (body.confidence * 100).toFixed(0) + "%"} · ${body.fidelity === 2 ? "high" : body.fidelity === 1 ? "low" : "unknown"} fidelity · calibration ${["unknown", "valid", "calibrating", "invalid"][body.calibration ?? 0]}` : "Body tracking unavailable");
  while (poseRows.length > (sample?.poses.length ?? 0)) poseRows.pop()!.remove();
  sample?.poses.forEach((pose, i) => {
    if (!poseRows[i]) {
      poseRows[i] = document.createElement("div");
      element("pose-values").append(poseRows[i]);
    }
    setText(poseRows[i], `${stream?.sources[i]} · ${pose.active === false ? "inactive" : !(pose.flags & 2) ? "position invalid" : pose.position.map(n => n.toFixed(3)).join(" / ") + " m"} · ${pose.flags & 1 ? "orientation valid" : "orientation invalid"}`);
  });
  text("input-status", inputStream ? `${inputStream.statistics.rate.toFixed(1)} Hz · ${inputStream.statistics.messages.missing} missing` : "Not advertised");
  while (inputRows.length > (inputStream?.sample?.inputs.length ?? 0)) inputRows.pop()!.row.remove();
  inputStream?.sample?.inputs.forEach((input, i) => {
    if (!inputRows[i]) {
      const row = document.createElement("div"), label = document.createElement("strong"), value = document.createElement("span"), counts = document.createElement("small");
      row.append(label, value, counts);
      element("input-values").append(row);
      inputRows[i] = { row, label, value, counts };
    }
    const { row, label, value, counts } = inputRows[i], definition = inputStream.descriptor.inputs[i];
    setText(label, `${definition.source} · ${definition.label}`);
    setText(value, inputStream.statistics.stale ? "stale" : !input.active ? "inactive" : typeof input.value === "boolean" ? (input.value ? "Pressed / touched" : "Released") : typeof input.value === "number" ? input.value.toFixed(3) : input.value.map(n => n.toFixed(3)).join(" / "));
    row.classList.toggle("pressed", input.active && input.value === true && !inputStream.statistics.stale);
    setAttribute(counts, "hidden", input.type === 0 ? null : "");
    if (input.type === 0) setText(counts, `press ${input.presses} · release ${input.releases}`);
  });
  text("hello-badge", live ? "Hello accepted" : "Awaiting hello");
  element("hello-badge").classList.toggle("accepted", live);
  const session = state.hello?.session;
  text(
    "session-id",
    session
      ? `${session.high.toString(16).padStart(16, "0")} ${session.low.toString(16).padStart(16, "0")}`
      : "No session established",
  );
  text("handshake", state.hello ? "Accepted" : "Pending");
  text("versions", state.hello?.supportedVersions.join(", ") ?? "—");
  text("source-count", state.capabilities ? `${names.length + (state.capabilities.controller ? new Set(state.capabilities.controller.inputs.map(i => i.source)).size : 0) + (state.capabilities.body ? 1 : 0)} advertised` : "—");
  for (const name of ["control", "tracking"] as const) {
    text(name, state[name] === "open" ? "Open" : "Closed");
    element(name).classList.toggle("open", state[name] === "open");
  }
  text(
    "session-note",
    live
      ? state.source === "synthetic" ? "Synthetic poses exercise the real WebRTC transport. These are not headset measurements." : "Received poses retain their runtime validity and activity flags."
      : "Each connection negotiates a version and a device session before discovery.",
  );
  text(
    "footer-status",
    live
      ? "Receiving from device · Read-only inspection"
      : "No device connected",
  );
  updateMessages(state);
}

element("connect").onclick = () => {
  if (
    connection &&
    ["Connecting", "Connected"].includes(connection.state.status)
  ) {
    connection.close();
    connection = null;
    return;
  }
  connection?.close();
  resetControls = true;
  selected = null;
  rtts.length = 0;
  lastRtt = null;
  const next = new Connection((state) => {
    if (connection === next) { current = state; invalidateUI(); }
  });
  connection = next;
  void next.connect();
};
element("show-probes").onchange = invalidateUI;
window.addEventListener("pagehide", () => { cancelAnimationFrame(frame); connection?.close(); performancePanel.dispose(); void recording.stop("pagehide"); });

element("consumer-rate").onchange = () => {
  const rate = element<HTMLSelectElement>("consumer-rate").value;
  connection?.setConsumerRate(rate === "animation" ? rate : Number(rate));
};
for (const id of ["send-rate", "history"]) element(id).onchange = () => connection?.setPublication(Number(element<HTMLSelectElement>("send-rate").value), Number(element<HTMLSelectElement>("history").value), element<HTMLSelectElement>("stream-kind").value);
element("inspect-sample").onclick = () => {
  selected = { id: -1, at: new Date(), direction: "Received", channel: "tracking", kind: "Sample snapshot", bytes: 0, value: current.streams.find(s => s.descriptor.type === element<HTMLSelectElement>("stream-kind").value)?.sample ?? null };
  invalidateUI();
};

element("stream-kind").onchange = () => {
  selectPublication = true;
  invalidateUI();
};

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
