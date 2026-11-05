import { Connection, initialState } from "./connection";
import type { Entry, State } from "./connection";
import { json } from "./protocol";
import "./style.css";
import { drawPoses } from "./spatial";

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

function grid() {
  let lines = "";
  for (let i = -10; i <= 10; i++) {
    const project = (x: number, z: number) =>
      `${450 + (x - z) * 30},${330 + (x + z) * 13}`;
    lines += `<line x1="${450 + (i + 10) * 30}" y1="${330 + (i - 10) * 13}" x2="${450 + (i - 10) * 30}" y2="${330 + (i + 10) * 13}"/>`;
    lines += `<polyline points="${project(-10, i)} ${project(10, i)}"/>`;
  }
  return `<svg class="workspace-grid" viewBox="0 0 900 480" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs><radialGradient id="fade"><stop offset="0" stop-color="white"/><stop offset="1" stop-color="black"/></radialGradient><mask id="grid-fade"><rect width="900" height="480" fill="url(#fade)"/></mask></defs><g mask="url(#grid-fade)" stroke="#b8c8bd" stroke-width=".8" fill="none">${lines}</g><circle cx="450" cy="330" r="4" fill="#96a99d"/><path d="M450 330v-65" stroke="#809b87" stroke-width="1.5"/><path d="m450 330 90 39" stroke="#ba9990" stroke-width="1.5"/><path d="m450 330-90 39" stroke="#94a6c4" stroke-width="1.5"/></svg>`;
}

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
        <div class="viewport">${grid()}<svg id="poses" viewBox="0 0 900 480" role="img" aria-label="Received head and controller poses"></svg><div class="viewport-label"><span class="mini-dot"></span> <span id="data-source">SPATIAL VIEW</span></div><div id="empty-state" class="empty-state"><span class="empty-icon">${icon("head")}</span><h3 id="workspace-title">Your workspace is ready</h3><p id="workspace-note">Connect to discover the device’s tracking sources.</p></div><div class="viewport-footer"><span>+X right &nbsp; +Y up &nbsp; −Z forward</span><span>METRES · RIGHT-HANDED</span></div></div>
        <div class="sources" aria-label="Tracking capabilities">${(["head", "controller", "body"] as const).map((type, index) => `<div class="source">${icon(type)}<div><strong>${["Head & poses", "Controller inputs", "Body tracking"][index]}</strong><span class="source-state">Awaiting discovery</span></div><span class="source-dash">—</span></div>`).join("")}</div>
      </section>
      <aside class="panel session">
        <div class="panel-header"><h2>Session details</h2><span id="hello-badge" class="tag">Awaiting hello</span></div>
        <div class="session-body"><label>SERVER SESSION ID</label><code id="session-id">No session established</code><dl><div><dt>Handshake</dt><dd id="handshake">Pending</dd></div><div><dt>Supported versions</dt><dd id="versions">—</dd></div><div><dt>Tracking sources</dt><dd id="source-count">—</dd></div></dl><div class="section-label">DATA CHANNELS</div><div class="channel"><span class="channel-icon">⇄</span><div><strong>Control</strong><span>Reliable · ordered</span></div><span id="control" class="channel-state">Closed</span></div><div class="channel"><span class="channel-icon">↝</span><div><strong>Tracking</strong><span>Unordered · zero retries</span></div><span id="tracking" class="channel-state">Closed</span></div><div class="session-note"><span>i</span><p id="session-note">Each connection negotiates a version and a device session before discovery.</p></div></div>
      </aside>
    </div>
    <section class="panel tracking-stats" aria-label="Tracking statistics">
      <div class="panel-header"><h2>Tracking statistics</h2><span id="freshness" class="tag">Awaiting samples</span></div>
      <div class="tracking-controls"><label>Publication <select id="send-rate"><option value="100">100 Hz</option><option value="30">30 Hz</option><option value="10">10 Hz</option></select></label><label>History <select id="history"><option value="1">1 sample</option><option value="4">4 samples</option><option value="8">8 samples</option></select></label><label>Viewer consumer <select id="consumer-rate"><option value="30">30 Hz</option><option value="60">60 Hz</option><option value="5">5 Hz · slow consumer</option></select></label><button id="inspect-sample">Inspect latest sample</button></div>
      <dl class="tracking-numbers"><div><dt>Received rate</dt><dd id="tracking-rate">—</dd></div><div><dt>Missing messages</dt><dd id="missing">0</dd></div><div><dt>Reordered / duplicates</dt><dd id="reordered">0 / 0</dd></div><div><dt>Samples not received</dt><dd id="sample-gaps">0</dd></div><div><dt>Viewer coalesced</dt><dd id="coalesced">0</dd></div><div><dt>Estimated sample age</dt><dd id="sample-age">—</dd></div></dl>
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
  element(id).textContent = value;
};
text("target", __OPERATOR_TARGET__);
let connection: Connection | null = null;
let current = initialState();
let selected: Entry | null = null;
let lastRtt: number | null = null;
const rtts: number[] = [];
let messageSignature = "";

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
  const signature = `${entries.map((entry) => entry.id).join(",")}:${selected?.id}:${entries[0]?.at.getTime()}`;
  if (signature === messageSignature) return;
  messageSignature = signature;
  element("messages-empty").hidden = entries.length > 0;
  const tbody = element("message-rows");
  tbody.replaceChildren();
  for (const entry of entries.toReversed()) {
    const row = document.createElement("tr");
    row.classList.toggle("selected", selected?.id === entry.id);
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
      updateMessages(current);
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

function render(state: State) {
  current = state;
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
  element("sparkline")
    .querySelector("polyline")!
    .setAttribute(
      "points",
      live
        ? rtts
            .map((rtt, i) => `${i * 4},${26 - (rtt / ceiling) * 22}`)
            .join(" ")
        : "",
    );
  text("received", state.received.toLocaleString());
  text(
    "received-bytes",
    `${state.bytes.toLocaleString()} bytes this connection`,
  );
  text("connect", live ? "Disconnect" : busy ? "Cancel" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  element("error").hidden = state.status !== "Error";
  text("error", state.detail);
  text(
    "workspace-title",
    live ? (state.stream ? "Waiting for valid poses" : "Waiting for tracking sources") : "Your workspace is ready",
  );
  text(
    "workspace-note",
    live
      ? state.stream ? "Invalid or inactive poses are hidden until tracking resumes." : "The device is connected. Tracking is currently unavailable."
      : "Connect to discover the device’s tracking sources.",
  );
  const names = state.capabilities?.pose ? state.capabilities.pose.sources : [];
  document.querySelectorAll(".source-state").forEach((source, i) => { source.textContent = i === 0 && names.length ? `${names.length} pose sources · 100 Hz` : live ? "Not advertised" : "Awaiting discovery"; });
  text("stream-count", `${state.stream ? 1 : 0} active streams`);
  text("data-source", !live ? "SPATIAL VIEW" : state.source === "synthetic" ? "SYNTHETIC TEST SOURCE" : state.source === "openxr" ? "OPENXR · LOCAL SPACE" : "SOURCE UNAVAILABLE");
  for (const id of ["send-rate", "history"]) element<HTMLSelectElement>(id).disabled = !state.stream;
  const stats = state.statistics;
  text("tracking-rate", `${stats.rate.toFixed(1)} Hz`);
  text("missing", String(stats.messages.missing));
  text("reordered", `${stats.messages.reordered} / ${stats.messages.duplicates}`);
  text("sample-gaps", String(stats.samples.missing));
  text("coalesced", String(stats.consumer.coalesced));
  text("sample-age", stats.age === null ? "—" : `${Math.max(0, stats.age).toFixed(1)} ms`);
  text("freshness", stats.stale ? "Stale / awaiting samples" : "Receiving samples");
  element("empty-state").hidden = !!state.sample?.poses.some(p => (p.flags & 2) && p.active !== false);
  drawPoses(document.querySelector<SVGSVGElement>("#poses")!, state.sample, state.stream?.sources ?? [], stats.stale);
  const values = element("pose-values"); values.replaceChildren();
  state.sample?.poses.forEach((pose, i) => {
    const row = document.createElement("div");
    row.textContent = `${state.stream?.sources[i]} · ${pose.active === false ? "inactive" : !(pose.flags & 2) ? "position invalid" : pose.position.map(n => n.toFixed(3)).join(" / ") + " m"} · ${pose.flags & 1 ? "orientation valid" : "orientation invalid"}`;
    values.append(row);
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
  text("source-count", state.capabilities ? `${names.length} advertised` : "—");
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
  element<HTMLSelectElement>("send-rate").value = "100";
  element<HTMLSelectElement>("history").value = "1";
  element<HTMLSelectElement>("consumer-rate").value = "30";
  selected = null;
  rtts.length = 0;
  lastRtt = null;
  const next = new Connection((state) => {
    if (connection === next) render(state);
  });
  connection = next;
  void next.connect();
};
element("show-probes").onchange = () => updateMessages(current);
window.addEventListener("pagehide", () => connection?.close());
render(current);

element("consumer-rate").onchange = () => connection?.setConsumerRate(Number(element<HTMLSelectElement>("consumer-rate").value));
for (const id of ["send-rate", "history"]) element(id).onchange = () => connection?.setPublication(Number(element<HTMLSelectElement>("send-rate").value), Number(element<HTMLSelectElement>("history").value));
element("inspect-sample").onclick = () => {
  selected = { id: -1, at: new Date(), direction: "Received", channel: "tracking", kind: "Pose sample snapshot", bytes: 0, value: current.sample };
  updateMessages(current);
};
