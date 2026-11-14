import { Connection, initialState } from "./connection";
import { spatialFrames, stale, valueText } from "./tracking-view";
import { kindNames, formatNames, spaceNames, preferredFormat, referenceFields, restGroup } from "./protocol";
import type { Session } from "./session";
import type { State } from "./connection";
import "./style.css";
import type { SpatialView } from "./spatial";
import { profiler, mountPerformancePanel } from "./performance";
import { recording } from "./recording";
import { setAttribute, setText } from "./dom";
import { TwoSecondMedian } from "./statistics";
import { mountFreshnessIndicator } from "./freshness-view";
import { groupColor, mountGroupLegend, mountSparkline, neutralColor } from "./sparkline";

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
      <div><div class="eyebrow">OPERATOR / CONNECTION</div><h1>A window into your device.</h1><p>Inspect live poses, body joints and inputs. Choose exactly what the device publishes.</p></div>
      <div class="connection-box"><div><label>DEVICE ENDPOINT</label><span id="target" class="mono"></span><span class="connection-status"><span id="status-dot" class="status-dot" aria-hidden="true"></span><span id="status" aria-live="polite">Disconnected</span></span></div><button id="connect" class="primary">Connect <span aria-hidden="true">↗</span></button></div>
    </section>
    <div id="error" class="error" role="alert" hidden></div>
    <section class="metrics" aria-label="Viewer metrics">
      <div class="metric" id="freshness"></div>
      <div class="metric" id="arrival-metric"><label>ARRIVAL RATE</label><div class="metric-value"><strong id="arrival-rate">—</strong></div></div>
      <div class="metric" id="latency-metric"><label>NETWORK LATENCY</label><div class="metric-value"><strong id="estimated-latency">—</strong></div></div>
      <div class="metric" id="age-metric"><label>SAMPLE AGE AT PHOTON</label><div class="metric-value"><strong id="sample-age">—</strong></div></div>
      <div class="metric" id="frame-metric"><label>FRAME RATE</label><div class="metric-value"><strong id="frame-rate">—</strong></div></div>
    </section>
    <section class="panel workspace">
      <div class="panel-header"><h2><span class="panel-symbol">⌘</span> Tracking workspace</h2></div>
      <div class="viewport"><div id="poses"></div><div id="empty-state" class="empty-state"><span class="empty-icon">${icon("head")}</span><h3 id="workspace-title">Ready to connect</h3><p id="workspace-note">Connect to inspect the device’s tracking data.</p></div></div>
      <div class="view-controls"><label>Skeleton <select id="skeleton-view"><option value="live">Live</option><option value="rest">Rest pose</option></select></label><label>View <select id="view-angle"><option value="iso">Perspective</option><option value="front">Front</option><option value="side">Side</option></select></label><label>Zoom <input id="view-zoom" type="range" min="0.6" max="1.5" step="0.1" value="1"></label><label title="Green: tracked · Orange: untracked · Grey: unknown/rest · Red: late"><input id="show-joints" type="checkbox" checked> Joint overlay</label><label><input id="continuous-render" type="checkbox" checked> Continuous rendering</label><label>Render-to-photon <input id="render-to-photon" type="number" min="0" max="1000" step="any" value="20" required aria-label="Render-to-photon latency in milliseconds"> ms</label><span id="prediction-horizon">Prediction horizon: not reported</span><span id="body-quality">Body tracking unavailable</span><span id="graphics-status" role="status">Loading 3D view…</span></div>
    </section>
    <section class="panel subscriptions-panel"><div class="panel-header"><h2>Samples & publication</h2><span id="sample-summary" class="tag">No capabilities</span></div><p id="publication-status" class="publication-status" role="status"></p><div id="subscriptions" class="subscriptions"><p>Connect to discover selectable samples.</p></div></section>
    <section class="panel performance-panel" id="performance" aria-label="Performance profiling"></section>
    <footer><span><span class="footer-mark">×</span> XR Operator <span class="footer-separator">/</span> Viewer</span><span id="footer-status">No device connected</span></footer>
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
let spatialKey = "";
let trackingView = spatialFrames(undefined, 0);
let mountedSession: Session | undefined;
const sampleRows = new Map<number, { value: HTMLElement; check: HTMLInputElement; format: HTMLSelectElement; space: HTMLSelectElement; row: HTMLElement }>();
let graphicsStatus = "Loading 3D view…";
let recordingStatus: { message: string; label: string; failed: boolean } | undefined;
const setGraphicsStatus = (message: string) => { graphicsStatus = message; };
const sampleAgeMedian = new TwoSecondMedian();
const arrivalRateMedian = new TwoSecondMedian();
const latencyMedian = new TwoSecondMedian();
const frameRateMedian = new TwoSecondMedian();
let renderToPhotonMs = 20;
const animate = (frameTime: number) => {
  frame = requestAnimationFrame(animate);
  if (document.hidden) return;
  profiler.animationFrame(frameTime);
  // The frame timestamp may precede packet callbacks already processed this frame.
  const now = performance.now();
  const session = current.session;
  const rest = element<HTMLSelectElement>("skeleton-view").value === "rest";
  const key = `${rest}:` + (session ? [...session.active.values()].map(s => `${s.generation}:${s.packet?.timestamp}:${stale(s, now)}`).join(";") : "");
  if (key !== spatialKey) {
    spatialKey = key;
    trackingView = spatialFrames(session, now, rest);
  }
  spatial?.update(trackingView.poses, trackingView.sources, !rest && current.freshness.status === "Late", trackingView.body, trackingView.hierarchy);
  const started = profiler.begin();
  try { renderState(current, trackingView, now); } finally { profiler.end("ui", started); }
  spatial?.renderFrame();
  performancePanel.renderFrame();
};
let frame = requestAnimationFrame(animate);
const performancePanel = mountPerformancePanel(element("performance"));
const freshnessIndicator = mountFreshnessIndicator(element("freshness"));
const arrivalChart = mountSparkline(element("arrival-metric"), "arrival-chart", "Arrivals per second.\nSolid: actual. Dashed: requested.");
const arrivalGroups = mountGroupLegend(arrivalChart.tooltip);
const latencyChart = mountSparkline(element("latency-metric"), "latency-chart", "Estimated one-way latency.");
const frameChart = mountSparkline(element("frame-metric"), "frame-chart", "Frames rendered per second.");
const ageChart = mountSparkline(element("age-metric"), "age-chart", "Estimated age when displayed.\nNegative means predicted ahead.");
let metricSession: Session | undefined;
if (import.meta.env.DEV) {
  recording.start({ type: "session", endpoint: __OPERATOR_TARGET__, viewerVersion: "0.1.0" }, (message, failed) => {
    recordingStatus = { message, failed, label: failed ? "Recording incomplete" : recording.active ? "Recording" : "Saved" };
  });
}
void import("./spatial").then(({ SpatialView }) => {
  spatial = new SpatialView(element("poses"), setGraphicsStatus);
  spatial.showJoints(element<HTMLInputElement>("show-joints").checked);
  spatialKey = "uninitialized";
  spatial.setContinuousRendering(element<HTMLInputElement>("continuous-render").checked);
}).catch(() => setGraphicsStatus("WebGL is unavailable."));

function renderState(state: State, view: ReturnType<typeof spatialFrames>, now: number) {
  if (metricSession !== state.session) {
    metricSession = state.session;
    for (const chart of [freshnessIndicator, arrivalChart, latencyChart, ageChart]) chart.reset();
    sampleAgeMedian.reset(); arrivalRateMedian.reset(); latencyMedian.reset();
  }
  freshnessIndicator.update(state.freshness);
  text("graphics-status", graphicsStatus);
  if (recordingStatus) {
    const status = element("recording-status");
    setAttribute(status, "hidden", null);
    setText(status, recordingStatus.label);
    setAttribute(status, "title", recordingStatus.message);
    setAttribute(status, "aria-label", recordingStatus.message);
    status.classList.toggle("recording-failed", recordingStatus.failed);
  }
  const live = state.status === "Connected", busy = state.status === "Connecting";
  text("status", state.status);
  element("status-dot").classList.toggle("live", live);
  element("status-dot").classList.toggle("busy", busy);
  text("connect", live ? "Disconnect" : busy ? "Cancel" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  setAttribute(element("error"), "hidden", state.status !== "Error" ? "" : null);
  text("error", state.detail);
  text("publication-status", state.detail);
  text("footer-status", live ? "Connected" : "No device connected");
  const session = state.session;
  if (mountedSession && mountedSession !== session) {
    mountedSession = undefined; sampleRows.clear();
    element("subscriptions").replaceChildren(document.createTextNode("Connect to discover selectable samples."));
    text("sample-summary", "No capabilities");
  }
  if (session?.capabilities && mountedSession !== session) mountCapabilities(session);
  const subscriptions = [...session?.active.values() ?? []];
  const received = subscriptions.filter(s => s.arrivedAt !== undefined);
  const rates = subscriptions.map(s => ({
    key: `${s.request.id}:${s.generation}`, group: s.request.group, onChange: s.onChange,
    requested: s.onChange ? undefined : s.request.rate,
    actual: s.arrivals.filter(at => at > now - 1000 && at <= now).length,
  }));
  const displayedRate = arrivalRateMedian.update(subscriptions.length ? rates.reduce((sum, s) => sum + s.actual, 0) : undefined, now);
  text("arrival-rate", displayedRate === undefined ? "—" : `${displayedRate.toFixed(1)} Hz`);
  arrivalGroups(rates);
  arrivalChart.update(rates.flatMap(s => [
    ...s.requested === undefined ? [] : [{ key: `${s.key}:requested`, value: s.requested, color: groupColor(s.group), dashed: true, className: "arrival-requested-line" }],
    { key: `${s.key}:actual`, value: s.actual, color: groupColor(s.group), className: "arrival-actual-line" },
  ]), now);
  const sampleTime = received.filter(s => !s.onChange && s.request.samples.some(sample => session!.capabilities!.descriptors[sample.descriptor].kind === 10))
    .reduce<bigint | undefined>((latest, s) => latest === undefined || s.packet!.timestamp > latest ? s.packet!.timestamp : latest, undefined);
  const sampleAge = sampleTime === undefined || state.predictionHorizonMs === undefined ? undefined : session?.sampleAge(sampleTime, now, renderToPhotonMs, state.predictionHorizonMs);
  const age = sampleAgeMedian.update(sampleAge, now);
  text("sample-age", age === undefined ? "—" : `${age.toFixed(2)} ms`);
  const latency = session?.latestNetworkLatency(now);
  const displayedLatency = latencyMedian.update(latency, now);
  text("estimated-latency", displayedLatency === undefined ? "—" : `${displayedLatency.toFixed(2)} ms`);
  latencyChart.update([{ key: "probe", value: latency, color: neutralColor, peak: true }], now);
  const fps = profiler.frameRate(now);
  const displayedFps = frameRateMedian.update(fps, now);
  text("frame-rate", displayedFps === undefined ? "—" : `${displayedFps.toFixed(0)} fps`);
  frameChart.update([{ key: "frames", value: fps, color: neutralColor }], now);
  ageChart.update([{ key: "age", value: sampleAge, color: neutralColor }], now);
  text("prediction-horizon", state.predictionHorizonMs === undefined ? "Prediction horizon: not reported" : `Prediction horizon: ${state.predictionHorizonMs} ms`);
  const values = view.values;
  const visiblePoses = view.poses.poses.length + (view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0);
  const visibleJoints = view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0;
  for (const [index, nodes] of sampleRows) {
    const current = values.get(index), d = session!.capabilities!.descriptors[index];
    let label = !current ? "Not subscribed" : current.stale ? "Stale · awaiting current data" : valueText(current.value);
    const delta = current?.subscription.deltas.get(current.selection);
    if (delta !== undefined && current?.value !== null && !current?.stale) label += ` · +${delta} ${d.kind === 11 ? "revisions" : "edges"}`;
    if (current && !current.stale && [2,5].includes(d.kind)) for (const field of referenceFields(d.kind)) {
      const counter = d[field] == null ? undefined : values.get(d[field]!);
      const edges = counter?.subscription.deltas.get(counter.selection);
      if (counter && !counter.stale && counter.value !== null && edges !== undefined) label += ` · ${kindNames[session!.capabilities!.descriptors[d[field]!].kind]} +${edges}`;
    }
    setText(nodes.value, label);
    setAttribute(nodes.row, "data-available", String(!!current && !current.stale && current.value !== null));

  }
  setAttribute(element("empty-state"), "hidden", visiblePoses && !view.mixedSpaces ? "" : null);
  text("workspace-title", view.mixedSpaces ? "Mixed reference spaces" : live ? "No current poses" : "Ready to connect");
  text("workspace-note", view.mixedSpaces ? "Choose the same reference space for pose samples to display them together. Numerical values remain available below." : live ? "Select pose samples and start publication. Select the associated validity samples to display pose components. Inactive and stale poses are hidden." : "Connect to inspect the device’s tracking data.");
  text("body-quality", `${visibleJoints} current body joints · ${view.mixedSpaces ? "mixed spaces; overlay hidden" : view.space ? view.space < 0 ? "skeleton rest frame" : spaceNames[view.space] : "no current frame"} · ${view.outdated.size ? "rest revision pending" : view.rest ? "advertised rest poses" : `${view.trackedJoints} reported tracked${view.confidence === undefined ? "" : ` · confidence ${(100 * view.confidence).toFixed(0)}%`}`}`);
  for (let group = 0; group < (session?.capabilities?.groups.length ?? 0); group++) {
    const id = group + 1, active = session!.active.get(id), pending = session!.pending.has(id) || session!.stopping.has(id);
    element<HTMLButtonElement>(`publish-${group}`).disabled = pending;
    element<HTMLButtonElement>(`stop-${group}`).disabled = !active || pending;
    text(`publish-${group}`, pending ? "Pending…" : active ? "Apply replacement" : "Start publication");
    text(`subscription-${group}`, active ? `Generation ${active.generation} · ${active.request.samples.length} samples · ${active.onChange ? "on change" : `${active.request.rate} Hz target`} · ${active.request.delivery === 2 ? "reliable" : "unreliable"} · ${active.packets} packets` : pending ? "Waiting for control response" : "No active publication");
  }
}

function mountCapabilities(session: Session) {
  sampleAgeMedian.reset();
  mountedSession = session; sampleRows.clear();
  const c = session.capabilities!, container = element("subscriptions"); container.replaceChildren();
  text("sample-summary", `${c.descriptors.length} samples · ${c.groups.length} acquisition groups`);
  c.groups.forEach((max, group) => {
    const section = document.createElement("section"); section.className = "subscription-group";
    section.style.setProperty("--group-color", groupColor(group));
    const delivery = session.active.get(group + 1)?.request.delivery ?? session.pending.get(group + 1)?.delivery ?? (restGroup(c, group) ? 2 : 1);
    section.innerHTML = `<div class="publication-controls"><strong class="group-label">Group ${group}</strong><label class="rate-control">Rate <input id="rate-${group}" type="number" min="0.1" max="${max}" step="any" value="${Math.min(max,60)}" aria-label="Group ${group} publication rate"> Hz (max ${max})</label><span class="change-cadence">On change</span><label>Delivery <select id="delivery-${group}" aria-label="Group ${group} delivery"><option value="1" ${delivery === 1 ? "selected" : ""}>Unreliable</option><option value="2" ${delivery === 2 ? "selected" : ""}>Reliable</option></select></label><button id="publish-${group}">Apply replacement</button><button id="stop-${group}">Stop publication</button><button class="select-all">Select all</button><button class="select-none">Clear selection</button></div><p id="subscription-${group}" class="subscription-status"></p><div class="sample-table-wrap"><table class="sample-table"><thead><tr><th>Select</th><th>Sample</th><th>Kind</th><th>Format</th><th>Space</th><th>Current value</th></tr></thead><tbody></tbody></table></div>`;
    const deliverySelect = section.querySelector<HTMLSelectElement>(`#delivery-${group}`)!;
    const updateCadence = () => {
      const onChange = restGroup(c, group) && deliverySelect.value === "2";
      section.querySelector<HTMLElement>(".rate-control")!.hidden = onChange;
      section.querySelector<HTMLElement>(".change-cadence")!.hidden = !onChange;
    };
    deliverySelect.onchange = updateCadence; updateCadence();
    const tbody = section.querySelector("tbody")!;
    c.descriptors.forEach((d, index) => {
      if (d.group !== group) return;
      const row = document.createElement("tr"); row.dataset.descriptor = d.id;
      const check = document.createElement("input"); check.type = "checkbox"; check.checked = true; check.setAttribute("aria-label", `Select ${d.name || d.id}`);
      const name = document.createElement("span"); name.textContent = d.name || d.id; name.title = `${d.id}\n${d.description}`;
      const references = referenceFields(d.kind).flatMap(field => d[field] == null ? [] : [`${kindNames[c.descriptors[d[field]!].kind]}: ${c.descriptors[d[field]!].name || c.descriptors[d[field]!].id}`]);
      if (d.revision_of !== undefined) references.push(`Versions group ${d.revision_of}`);
      name.title += references.length ? `\n${references.join("\n")}` : "";
      const kind = document.createElement("span"); kind.textContent = kindNames[d.kind];
      const format = document.createElement("select"); format.setAttribute("aria-label", `Format for ${d.name || d.id}`);
      for (const f of d.formats) format.add(new Option(formatNames[f], String(f)));
      format.value = String(preferredFormat(d));
      const space = document.createElement("select"); space.setAttribute("aria-label", `Space for ${d.name || d.id}`);
      for (const s of d.spaces.length ? d.spaces : [0]) space.add(new Option(spaceNames[s], String(s)));
      space.disabled = d.kind !== 10;
      const value = document.createElement("span"); value.textContent = "Awaiting publication"; value.className = "sample-value";
      for (const item of [check, name, kind, format, space, value]) { const cell = document.createElement("td"); cell.append(item); row.append(cell); }
      tbody.append(row); sampleRows.set(index, { row, check, format, space, value });
    });
    section.querySelector<HTMLButtonElement>(".select-all")!.onclick = () => { for (const [index, row] of sampleRows) if (c.descriptors[index].group === group) row.check.checked = true; };
    section.querySelector<HTMLButtonElement>(".select-none")!.onclick = () => { for (const [index, row] of sampleRows) if (c.descriptors[index].group === group) row.check.checked = false; };
    container.append(section);
    element(`publish-${group}`).onclick = () => {
      const samples = [...sampleRows].filter(([index, row]) => c.descriptors[index].group === group && row.check.checked).map(([descriptor, row]) => ({ descriptor, format: Number(row.format.value), space: Number(row.space.value) }));
      connection?.publish({ id: group + 1, group, delivery: Number(element<HTMLSelectElement>(`delivery-${group}`).value), rate: Number(element<HTMLInputElement>(`rate-${group}`).value), samples });
    };
    element(`stop-${group}`).onclick = () => { connection?.unsubscribe(group + 1); };
  });
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
  const next = new Connection((state) => {
    if (connection === next) current = state;
  });
  connection = next;
  void next.connect();
};
window.addEventListener("pagehide", () => { cancelAnimationFrame(frame); connection?.close(); performancePanel.dispose(); void recording.stop("pagehide"); });

for (const id of ["view-angle", "view-zoom"]) element(id).oninput = () => {
  spatial?.setView(element<HTMLSelectElement>("view-angle").value, Number(element<HTMLInputElement>("view-zoom").value));
};

element("continuous-render").onchange = () => {
  const continuous = element<HTMLInputElement>("continuous-render").checked;
  spatial?.setContinuousRendering(continuous);
  recording.add({ type: "render-mode", continuous });
};

element<HTMLInputElement>("render-to-photon").oninput = () => {
  const input = element<HTMLInputElement>("render-to-photon"), value = input.valueAsNumber;
  if (!input.validity.valid || !Number.isFinite(value)) return;
  renderToPhotonMs = value; sampleAgeMedian.reset();
  recording.add({ type: "render-to-photon", milliseconds: value });
};

element("skeleton-view").onchange = () => spatial?.reframe();
element("show-joints").onchange = () => spatial?.showJoints(element<HTMLInputElement>("show-joints").checked);
if (import.meta.hot) import.meta.hot.dispose(() => { cancelAnimationFrame(frame); connection?.close(); spatial?.dispose(); performancePanel.dispose(); void recording.stop("hot-reload"); });
