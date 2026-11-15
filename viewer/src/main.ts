import { Connection, initialState } from "./connection";
import { spatialFrames, stale } from "./tracking-view";
import { spaceNames, publicationRate } from "./protocol";
import type { Session } from "./session";
import type { State } from "./connection";
import "./style.css";
import type { SpatialView } from "./spatial";
import { profiler } from "./performance";
import { mountPerformancePanel } from "./performance-view";
import { panelHeader } from "./ui/panel";
import { MetricDisplay } from "./ui/metric-display";
import { PublicationGroup } from "./ui/publication-group";
import type { Request } from "./protocol";
import { Recorder } from "./recording";
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
      <div class="connection-box"><div><span class="section-label">DEVICE ENDPOINT</span><span id="target" class="mono"></span><span class="connection-status"><span id="status-dot" class="status-dot" aria-hidden="true"></span><span id="status" aria-live="polite">Disconnected</span></span></div><button id="connect" class="primary">Connect <span aria-hidden="true">↗</span></button></div>
    </section>
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
      <div class="view-controls control-row"><label>Skeleton <select id="skeleton-view"><option value="live">Live</option><option value="rest">Rest pose</option></select></label><label>View <select id="view-angle"><option value="iso">Perspective</option><option value="front">Front</option><option value="side">Side</option></select></label><label>Zoom <input id="view-zoom" type="range" min="0.6" max="1.5" step="0.1" value="1"></label><label title="Green: tracked · Orange: untracked · Grey: unknown/rest · Red: late"><input id="show-joints" type="checkbox" checked> Joint overlay</label><label><input id="continuous-render" type="checkbox" checked> Continuous rendering</label><label>Render-to-photon <input id="render-to-photon" type="number" min="0" max="1000" step="any" value="20" required aria-label="Render-to-photon latency in milliseconds"> ms</label><span id="prediction-horizon">Prediction horizon: not reported</span><span id="body-quality">Body tracking unavailable</span><span id="graphics-status" class="status-message" role="status">Loading 3D view…</span></div>
    </section>
    <section class="panel subscriptions-panel"><span id="sample-summary" class="tag">No capabilities</span><p id="publication-status" class="publication-status status-message" role="status"></p><div id="subscriptions" class="subscriptions"><p>Connect to discover selectable samples.</p></div></section>
    <section class="panel performance-panel" id="performance" aria-label="Performance profiling"></section>
    <footer><span><span class="footer-mark">×</span> XR Operator <span class="footer-separator">/</span> Viewer</span><span id="footer-status">No device connected</span></footer>
  </main>`;

const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const text = (id: string, value: string) => {
  setText(element(id), value);
};
document.querySelector(".workspace")!.prepend(panelHeader("Tracking workspace"));
document.querySelector(".subscriptions-panel")!.prepend(panelHeader("Samples & publication", element("sample-summary")));
text("target", __OPERATOR_TARGET__);
let connection: Connection | null = null;
let recording: Recorder | undefined;
let current = initialState();
let spatial: SpatialView | undefined;
let spatialKey = "";
let trackingView = spatialFrames(undefined, 0);
let mountedSession: Session | undefined;
const publicationGroups: PublicationGroup[] = [];
let publicationError: string | undefined;
let graphicsStatus = "Loading 3D view…";
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
const freshnessIndicator = mountFreshnessIndicator(element<MetricDisplay>("freshness"));
const arrivalChart = mountSparkline(element("arrival-metric"), "arrival-chart", "Arrivals per second.\nSolid: actual. Dashed: requested.");
const arrivalGroups = mountGroupLegend(arrivalChart.tooltip);
const latencyChart = mountSparkline(element("latency-metric"), "latency-chart", "Estimated one-way latency.");
const frameChart = mountSparkline(element("frame-metric"), "frame-chart", "Frames rendered per second.");
const ageChart = mountSparkline(element("age-metric"), "age-chart", "Estimated age when displayed.\nNegative means predicted ahead.");
let metricSession: Session | undefined;
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
  if (recording) {
    const status = element("recording-status");
    setAttribute(status, "hidden", null);
    const label = recording.status === "error" ? "Recording stopped" : recording.status === "recording" ? "Recording" : recording.savedBytes < recording.bytes ? "Saving recording" : recording.status === "limit" ? "Recording stopped · 128 MiB limit" : "Recording saved";
    setText(status, `${label} · ${(recording.savedBytes / 1024 ** 2).toFixed(1)} MiB saved${recording.error ? ` · ${recording.error}` : ""}`);
    setAttribute(status, "title", recording.path);
  }
  const live = state.status === "Connected", busy = state.status === "Connecting";
  text("status", state.status);
  element("status-dot").classList.toggle("live", live);
  element("status-dot").classList.toggle("busy", busy);
  text("connect", live ? "Disconnect" : busy ? "Cancel" : "Connect ↗");
  element("connect").classList.toggle("secondary", live || busy);
  setAttribute(element("error"), "hidden", state.status !== "Error" ? "" : null);
  text("error", state.detail);
  text("footer-status", live ? "Connected" : "No device connected");
  const session = state.session;
  if (mountedSession && mountedSession !== session) {
    mountedSession = undefined; publicationGroups.length = 0;
    publicationError = undefined;
    element("subscriptions").replaceChildren(document.createTextNode("Connect to discover selectable samples."));
    text("sample-summary", "No capabilities");
  }
  text("publication-status", publicationError ?? state.detail);
  setAttribute(element("publication-status"), "data-tone", publicationError ? "error" : null);
  if (session?.capabilities && mountedSession !== session) mountCapabilities(session);
  const subscriptions = [...session?.active.values() ?? []];
  const received = subscriptions.filter(s => s.arrivedAt !== undefined);
  const rates = subscriptions.map(s => ({
    key: `${s.request.id}:${s.generation}`, group: s.request.group, onChange: s.request.schedule.kind === "onChange",
    requested: s.request.schedule.kind === "onChange" ? undefined : publicationRate(s.request),
    actual: s.arrivals.filter(at => at > now - 1000 && at <= now).length,
  }));
  const displayedRate = arrivalRateMedian.update(subscriptions.length ? rates.reduce((sum, s) => sum + s.actual, 0) : undefined, now);
  element<MetricDisplay>("arrival-metric").update(displayedRate);
  arrivalGroups(rates);
  arrivalChart.update(rates.flatMap(s => [
    ...s.requested === undefined ? [] : [{ key: `${s.key}:requested`, value: s.requested, color: groupColor(s.group), dashed: true, className: "arrival-requested-line" }],
    { key: `${s.key}:actual`, value: s.actual, color: groupColor(s.group), className: "arrival-actual-line" },
  ]), now);
  const sampleTime = received.filter(s => s.request.schedule.kind !== "onChange" && s.request.samples.some(sample => session!.capabilities!.descriptors[sample.descriptor].kind === 10))
    .reduce<bigint | undefined>((latest, s) => latest === undefined || (s.packet!.predictedFor ?? s.packet!.timestamp) > latest ? (s.packet!.predictedFor ?? s.packet!.timestamp) : latest, undefined);
  const sampleAge = sampleTime === undefined ? undefined : session?.sampleAge(sampleTime, now, renderToPhotonMs);
  const age = sampleAgeMedian.update(sampleAge, now);
  element<MetricDisplay>("age-metric").update(age);
  const latency = session?.latestNetworkLatency(now);
  const displayedLatency = latencyMedian.update(latency, now);
  element<MetricDisplay>("latency-metric").update(displayedLatency);
  latencyChart.update([{ key: "probe", value: latency, color: neutralColor, peak: true }], now);
  const fps = spatial?.frameRate(now);
  const displayedFps = frameRateMedian.update(fps, now);
  element<MetricDisplay>("frame-metric").update(displayedFps);
  frameChart.update([{ key: "frames", value: fps, color: neutralColor }], now);
  ageChart.update([{ key: "age", value: sampleAge, color: neutralColor }], now);
  text("prediction-horizon", state.predictionHorizonMs === undefined ? "Prediction horizon: not reported" : `Prediction horizon: ${state.predictionHorizonMs} ms`);
  const values = view.values;
  const visiblePoses = view.poses.poses.length + (view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0);
  const visibleJoints = view.body.active ? view.body.poses.filter(p => p.flags & 2).length : 0;
  setAttribute(element("empty-state"), "hidden", visiblePoses && !view.mixedSpaces ? "" : null);
  text("workspace-title", view.mixedSpaces ? "Mixed reference spaces" : live ? "No current poses" : "Ready to connect");
  text("workspace-note", view.mixedSpaces ? "Choose the same reference space for pose samples to display them together. Numerical values remain available below." : live ? "Select pose samples and start publication. Select the associated validity samples to display pose components. Inactive and stale poses are hidden." : "Connect to inspect the device’s tracking data.");
  text("body-quality", `${visibleJoints} current body joints · ${view.mixedSpaces ? "mixed spaces; overlay hidden" : view.space ? view.space < 0 ? "skeleton rest frame" : spaceNames[view.space] : "no current frame"} · ${view.outdated.size ? "rest revision pending" : view.rest ? "advertised rest poses" : `${view.trackedJoints} reported tracked${view.confidence === undefined ? "" : ` · confidence ${(100 * view.confidence).toFixed(0)}%`}`}`);
  publicationGroups.forEach((component, group) => {
    const active = subscriptions.find(s => s.request.group === group);
    const pending = [...session?.pending.values() ?? []].some(r => r.group === group);
    component.update(active, pending, values);
  });
}

function mountCapabilities(session: Session) {
  sampleAgeMedian.reset();
  mountedSession = session;
  publicationGroups.length = 0;
  const capabilities = session.capabilities!, container = element("subscriptions");
  container.replaceChildren();
  text("sample-summary", `${capabilities.descriptors.length} samples · ${capabilities.groups.length} acquisition groups`);
  capabilities.groups.forEach((_, group) => {
    const component = new PublicationGroup();
    component.configure(capabilities, group);
    publicationGroups.push(component);
    container.append(component);
  });
}

element("subscriptions").addEventListener("publication-request", event => {
  publicationError = undefined;
  try { connection?.publish((event as CustomEvent<Request>).detail); }
  catch (error) { publicationError = `Selection rejected: ${String(error)}`; }
});
element("subscriptions").addEventListener("publication-stop", event => {
  publicationError = undefined;
  connection?.unsubscribe((event as CustomEvent<number>).detail);
});
element("subscriptions").addEventListener("publication-error", event => { publicationError = (event as CustomEvent<string>).detail; });

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
  recording = import.meta.env.DEV ? new Recorder() : undefined;
  const next = new Connection((state) => {
    if (connection === next) current = state;
  }, recording);
  connection = next;
  void next.connect();
};
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
  renderToPhotonMs = value; sampleAgeMedian.reset();
};

element("skeleton-view").onchange = () => spatial?.reframe();
element("show-joints").onchange = () => spatial?.showJoints(element<HTMLInputElement>("show-joints").checked);
if (import.meta.hot) import.meta.hot.dispose(() => { cancelAnimationFrame(frame); connection?.close(); spatial?.dispose(); performancePanel.dispose(); });
