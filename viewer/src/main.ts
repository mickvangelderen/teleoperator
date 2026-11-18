import { Connection, initialState } from "./connection";
import { operatorOrigin } from "./operator-address";
import { spatialFrames, staleBundle } from "./tracking-view";
import { spaceNames } from "./protocol";
import type { Session } from "./session";
import { selectedBundle } from "./session";
import type { State } from "./connection";
import "./style.css";
import type { SpatialView } from "./spatial";
import { profiler } from "./performance";
import { mountPerformancePanel } from "./performance-view";
import { panelHeader } from "./ui/panel";
import { MetricDisplay } from "./ui/metric-display";
import { SubscriptionEditor } from "./ui/subscription-editor";
import { Recorder } from "./recording";
import { setAttribute, setText } from "./dom";
import { TwoSecondMedian } from "./statistics";
import { GroupMetrics } from "./group-metrics";
import { mountFreshnessIndicator } from "./freshness-view";
import { groupColor, mountGroupLegend, mountSparkline, neutralColor } from "./sparkline";

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
    <h1 class="product-title"><a class="brand" href="/" aria-label="Teleoperator protocol home"><span class="brand-mark" aria-hidden="true">×</span><span>Teleoperator protocol</span></a></h1>
    <form class="connection-box"><label class="endpoint"><span class="section-label">OPERATOR ADDRESS</span><input id="target" type="url" class="mono" required spellcheck="false" autocomplete="off" disabled></label><span class="connection-status"><span id="status-dot" class="status-dot" aria-hidden="true"></span><span id="status" aria-live="polite">Disconnected</span></span><button id="connect" class="primary">Connect <span aria-hidden="true">↗</span></button></form>
  </header>
  <main>
    <div id="error" class="status-message" data-tone="error" role="alert" hidden></div>
    <p id="recording-status" class="recording-status" role="status" hidden></p>
    <section class="metrics" aria-label="Viewer metrics">
      <viewer-metric id="freshness" label="FRESHNESS" value-id="freshness-age" unit="ms" precision="1"></viewer-metric>
      <viewer-metric id="arrival-metric" label="ARRIVAL RATE" value-id="arrival-rate" unit="Hz" precision="1"></viewer-metric>
      <viewer-metric id="latency-metric" label="NETWORK LATENCY" value-id="estimated-latency" unit="ms" precision="2"></viewer-metric>
      <viewer-metric id="age-metric" label="SAMPLE AGE AT PHOTON" value-id="sample-age" unit="ms" precision="2"></viewer-metric>
      <viewer-metric id="frame-metric" label="FRAME RATE" value-id="frame-rate" unit="fps" precision="0"></viewer-metric>
    </section>
    <section class="panel workspace">
      <div class="viewport"><div id="poses"></div><div id="empty-state" class="empty-state"><span class="empty-icon">${icon("head")}</span><h3 id="workspace-title">Ready to connect</h3><p id="workspace-note">Connect to inspect the device’s tracking data.</p></div></div>
      <div class="view-controls control-row"><label>Skeleton <select id="skeleton-view"><option value="live">Live</option><option value="rest">Rest pose</option></select></label><label>View <select id="view-angle"><option value="iso">Perspective</option><option value="front">Front</option><option value="side">Side</option></select></label><label>Zoom <input id="view-zoom" type="range" min="0.6" max="1.5" step="0.1" value="1"></label><label title="Meta upper-body skin, when matching live and rest poses are available"><input id="show-body-mesh" type="checkbox" checked> Body mesh</label><label title="Green: tracked · Orange: untracked · Grey: unknown/rest · Red: late"><input id="show-joints" type="checkbox" checked> Joint overlay</label><label><input id="continuous-render" type="checkbox" checked> Continuous rendering</label><label>Render-to-photon <input id="render-to-photon" type="number" min="0" max="1000" step="any" value="0" required aria-label="Render-to-photon latency in milliseconds"> ms</label><div class="view-status"><div class="prediction-timing" aria-label="Prediction timing"><span id="prediction-offset-label">Prediction timing</span><span id="requested-prediction-offset" title="Requested offset from the publication slot to the desired device target. This does not establish actual prediction.">Requested: unavailable</span><span id="measured-prediction-offset" title="Actual device target minus acquisition time (predicted_for − acquired_at), when the source reports a target. Publication time is not supplied, so this is not measured publication-to-consumption delay.">Device target − acquisition: unavailable</span></div><span id="body-quality">Body tracking unavailable</span><span id="graphics-status" class="status-message" role="status">Loading 3D view…</span></div></div>
    </section>
    <section class="panel subscriptions-panel"><span id="sample-summary" class="tag">No capabilities</span><div id="subscriptions"><p class="subscriptions-empty">Connect to discover selectable samples.</p></div></section>
    <section class="panel performance-panel" id="performance" aria-label="Performance profiling"></section>
  </main>`;

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const text = (id: string, value: string) => {
  setText(element(id), value);
};
document.querySelector(".workspace")!.prepend(panelHeader("Tracking workspace"));
document.querySelector(".subscriptions-panel")!.prepend(panelHeader("Subscriptions", element("sample-summary")));
const target = element<HTMLInputElement>("target");
let connection: Connection | null = null;
let recording: Recorder | undefined;
let current = initialState();
let spatial: SpatialView | undefined;
let spatialKey = "";
let trackingView = spatialFrames(undefined, 0);
let mountedSession: Session | undefined;
let subscriptionEditor: SubscriptionEditor | undefined;
let graphicsStatus = "Loading 3D view…";
const setGraphicsStatus = (message: string) => { graphicsStatus = message; };
const groupMetrics = new GroupMetrics();
const latencyMedian = new TwoSecondMedian();
const frameRateMedian = new TwoSecondMedian();
let renderToPhotonMs = 0;
const animate = (frameTime: number) => {
  frame = requestAnimationFrame(animate);
  if (document.hidden) return;
  performancePanel.measureFrame();
  profiler.animationFrame(frameTime);
  // The frame timestamp may precede packet callbacks already processed this frame.
  const now = performance.now();
  connection?.frame(frameTime, now, renderToPhotonMs);
  const session = current.session;
  const rest = element<HTMLSelectElement>("skeleton-view").value === "rest";
  const subscriptions = [...(session?.active.values() ?? [])];
  const overlappingGroups = new Set(subscriptions.map(s => s.request.group)).size < subscriptions.length;
  const key = `${rest}:${overlappingGroups ? session?.consumptionTime : ""}:` + subscriptions.map(s => `${s.generation}:${s.version}:` + s.bundles.map((_, i) => { const p = selectedBundle(s, i)?.packet; return `${p?.timestamp}:${p?.predictedFor}:${staleBundle(s, i, now)}`; }).join(",")).join(";");
  if (key !== spatialKey) {
    spatialKey = key;
    trackingView = spatialFrames(session, now, rest);
  }
  spatial?.update(trackingView.poses, trackingView.sources, !rest && current.freshness.status === "Late", trackingView.body, trackingView.hierarchy, trackingView.bodyMesh);
  const started = profiler.begin();
  try { renderState(current, trackingView, now); } finally { profiler.end("ui", started); }
  spatial?.renderFrame();
  performancePanel.renderFrame();
};
let frame = requestAnimationFrame(animate);
const performancePanel = mountPerformancePanel(element("performance"));
const freshnessIndicator = mountFreshnessIndicator(element<MetricDisplay>("freshness"));
const arrivalChart = mountSparkline(element("arrival-metric"), "arrival-chart", "Message arrivals per second by group.\nHeadline: mean of 2 s group medians, continuous dynamic groups only.\nSolid: actual. Dashed: requested.");
const arrivalGroups = mountGroupLegend(arrivalChart.tooltip);
const latencyChart = mountSparkline(element("latency-metric"), "latency-chart", "Estimated one-way latency.");
const frameChart = mountSparkline(element("frame-metric"), "frame-chart", "Frames rendered per second.");
const ageChart = mountSparkline(element("age-metric"), "age-chart", "Age at photon by continuous dynamic group.\nHeadline: mean of 2 s group medians; unknown if any group is missing.\nNegative means the actual device target is ahead.");
const ageGroups = mountGroupLegend(ageChart.tooltip);
let metricSession: Session | undefined;
void import("./spatial").then(({ SpatialView }) => {
  spatial = new SpatialView(element("poses"), setGraphicsStatus);
  spatial.showBodyMesh(element<HTMLInputElement>("show-body-mesh").checked);
  spatial.showJoints(element<HTMLInputElement>("show-joints").checked);
  spatialKey = "uninitialized";
  spatial.setContinuousRendering(element<HTMLInputElement>("continuous-render").checked);
}).catch(() => setGraphicsStatus("WebGL is unavailable."));

function renderState(state: State, view: ReturnType<typeof spatialFrames>, now: number) {
  if (metricSession !== state.session) {
    metricSession = state.session;
    for (const chart of [freshnessIndicator, arrivalChart, latencyChart, ageChart]) chart.reset();
    latencyMedian.reset();
  }
  freshnessIndicator.update(state.freshness);
  text("graphics-status", graphicsStatus);
  if (recording) {
    const status = element("recording-status");
    setAttribute(status, "hidden", null);
    const label = recording.status === "error" ? "Recording stopped" : recording.status === "recording" ? "Recording" : recording.savedBytes < recording.bytes ? "Saving recording" : recording.status === "limit" ? "Recording stopped · 128 MiB limit" : "Recording saved";
    setText(status, `${label} · ${(recording.savedBytes / 1024 ** 2).toFixed(1)} MiB saved${recording.error ? ` · ${recording.error}` : ""}`);
    setAttribute(status, "title", recording.path);
  } else setAttribute(element("recording-status"), "hidden", "");
  const live = state.status === "Connected", busy = state.status === "Connecting";
  setAttribute(target, "readonly", live || busy ? "" : null);
  setAttribute(target, "title", live ? "Disconnect to change the operator address." : busy ? "Cancel to change the operator address." : null);
  text("status", state.status);
  element("status-dot").classList.toggle("live", live);
  element("status-dot").classList.toggle("busy", busy);
  text("connect", live ? "Disconnect" : busy ? "Cancel" : state.status === "Error" ? "Retry" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  setAttribute(element("error"), "hidden", state.status !== "Error" ? "" : null);
  text("error", state.detail);
  const session = state.session;
  if (mountedSession && mountedSession !== session) {
    mountedSession = undefined; subscriptionEditor = undefined;
    element("subscriptions").replaceChildren(document.createTextNode("Connect to discover selectable samples."));
    text("sample-summary", "No capabilities");
  }
  if (session?.capabilities && mountedSession !== session) mountCapabilities(session);
  const subscriptions = [...session?.active.values() ?? []];
  const received = subscriptions.filter(s => s.arrivedAt !== undefined);
  const metrics = groupMetrics.update(session, now, renderToPhotonMs);
  element<MetricDisplay>("arrival-metric").update(metrics.arrival);
  arrivalGroups(metrics.groups);
  arrivalChart.update(metrics.groups.flatMap(group => [
    ...group.requested === undefined ? [] : [{ key: `${group.key}:requested`, value: group.requested, color: groupColor(group.group), dashed: true, className: "arrival-requested-line" }],
    { key: `${group.key}:actual`, value: group.arrival, color: groupColor(group.group), className: "arrival-actual-line" },
  ]), now);
  element<MetricDisplay>("age-metric").update(metrics.age);
  const ageMetrics = metrics.groups.filter(group => group.continuous);
  ageGroups(ageMetrics);
  ageChart.update(ageMetrics.map(group => ({ key: group.key, value: group.age, color: groupColor(group.group), peak: true })), now);
  const latency = session?.latestNetworkLatency(now);
  const displayedLatency = latencyMedian.update(latency, now);
  element<MetricDisplay>("latency-metric").update(displayedLatency);
  latencyChart.update([{ key: "probe", value: latency, color: neutralColor, peak: true }], now);
  const fps = spatial?.frameRate(now);
  const displayedFps = frameRateMedian.update(fps, now);
  element<MetricDisplay>("frame-metric").update(displayedFps);
  frameChart.update([{ key: "frames", value: fps, color: neutralColor }], now);
  const timing = received.find(s => s.packet?.predictedFor != null)
    ?? subscriptions[0];
  const prediction = timing?.packet, schedule = timing?.request;
  text("prediction-offset-label", timing ? `Prediction timing · Group ${timing.request.group}` : "Prediction timing");
  text("requested-prediction-offset", schedule ? `Requested: ${(Number(schedule.predictionOffset) / 1e6).toFixed(1)} ms` : "Requested: unavailable");
  text("measured-prediction-offset", prediction?.predictedFor == null ? "Device target − acquisition: unavailable" : `Device target − acquisition: ${(Number(prediction.predictedFor - prediction.timestamp) / 1e6).toFixed(1)} ms`);
  const visiblePoses = view.poses.poses.length + (view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0);
  const visibleJoints = view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0;
  setAttribute(element("empty-state"), "hidden", visiblePoses && !view.mixedSpaces ? "" : null);
  text("workspace-title", view.mixedSpaces ? "Mixed reference spaces" : live ? "No current poses" : "Ready to connect");
  text("workspace-note", view.mixedSpaces ? "Choose the same reference space for pose samples to display them together. Numerical values remain available below." : live ? "Select pose samples and start publication. Select the associated validity samples to display pose components. Inactive and stale poses are hidden." : "Connect to inspect the device’s tracking data.");
  const bodyQuality = `${visibleJoints} current body joints · ${view.mixedSpaces ? "mixed spaces; overlay hidden" : view.space ? view.space < 0 ? "skeleton rest frame" : spaceNames[view.space] : "no current frame"} · ${view.outdated.size ? "rest revision pending" : view.rest ? "advertised rest poses" : `${view.trackedJoints} reported tracked${view.confidence === undefined ? "" : ` · confidence ${(100 * view.confidence).toFixed(0)}%`}`}`;
  text("body-quality", bodyQuality);
  setAttribute(element("body-quality"), "title", bodyQuality);
  subscriptionEditor?.update(now);
}

function mountCapabilities(session: Session) {
  mountedSession = session;
  const capabilities = session.capabilities!, container = element("subscriptions");
  container.replaceChildren();
  text("sample-summary", `${capabilities.descriptors.length} samples · ${capabilities.groups.length} acquisition groups`);
  subscriptionEditor = new SubscriptionEditor();
  subscriptionEditor.configure(connection!);
  container.append(subscriptionEditor);
}

const connectButton = element<HTMLButtonElement>("connect");
connectButton.disabled = true;
fetch("/api/operator-address").then(async response => {
  if (!response.ok) throw new Error();
  target.value = operatorOrigin(await response.json());
}).catch(() => {
  current = { ...initialState(), status: "Error", detail: "Could not load the initial operator address. Enter an address to connect." };
}).finally(() => { target.disabled = false; connectButton.disabled = false; });

target.oninput = () => {
  target.setCustomValidity("");
  recording = undefined;
  profiler.resetConnectionMetrics();
  if (current.status === "Error") current = initialState();
};
document.querySelector<HTMLFormElement>(".connection-box")!.onsubmit = event => {
  event.preventDefault();
  if (
    connection &&
    ["Connecting", "Connected"].includes(connection.state.status)
  ) {
    connection.close();
    connection = null;
    return;
  }
  let address: string;
  try { address = operatorOrigin(target.value); }
  catch (error) {
    target.setCustomValidity((error as Error).message);
    target.reportValidity();
    return;
  }
  target.value = address;
  connection?.close();
  recording = import.meta.env.DEV ? new Recorder() : undefined;
  const next = new Connection((state) => {
    if (connection === next) current = state.status === "Error" ? { ...state, detail: `${address} — ${state.detail}` } : state;
  }, recording);
  connection = next;
  target.readOnly = true;
  void next.connect(address);
};
document.addEventListener("visibilitychange", () => connection?.visibilityChanged(performance.now(), !document.hidden));
window.addEventListener("pagehide", () => { cancelAnimationFrame(frame); connection?.close(); performancePanel.dispose(); });

for (const id of ["view-angle", "view-zoom"]) element(id).oninput = () => {
  spatial?.setView(element<HTMLSelectElement>("view-angle").value, Number(element<HTMLInputElement>("view-zoom").value));
};

element("continuous-render").onchange = () => {
  const continuous = element<HTMLInputElement>("continuous-render").checked;
  spatial?.setContinuousRendering(continuous);
};

element<HTMLInputElement>("render-to-photon").oninput = () => {
  const input = element<HTMLInputElement>("render-to-photon"), value = input.valueAsNumber;
  if (!input.validity.valid || !Number.isFinite(value)) return;
  renderToPhotonMs = value;
};

element("skeleton-view").onchange = () => spatial?.reframe();
element("show-body-mesh").onchange = () => spatial?.showBodyMesh(element<HTMLInputElement>("show-body-mesh").checked);
element("show-joints").onchange = () => spatial?.showJoints(element<HTMLInputElement>("show-joints").checked);
if (import.meta.hot) import.meta.hot.dispose(() => { cancelAnimationFrame(frame); connection?.close(); spatial?.dispose(); performancePanel.dispose(); });
