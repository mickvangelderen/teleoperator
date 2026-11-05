# Viewer

The Viewer and operator negotiate protocol v2; update both together. Lost
capabilities resubscribe when discovery restores them, while explicit unsubscribe
stays stopped until reconnect. Clock offset uses the lowest RTT in the last eight
replies and expires after five seconds without replies.

Read-only TypeScript interface for XR Operator. It displays the live hello
exchange, full-width session identity, advertised capabilities, channel state,
clock-probe round-trip time, message sizes, and decoded payloads. The spatial
workspace renders head and controller poses, controller input states and cumulative
transition counts, the 70-joint body skeleton and quality, their validity/activity, and per-stream
statistics. An explicit desktop synthetic source is labeled in the Viewer; the
Viewer never invents poses when the headset is unavailable.

The frontend uses pnpm, TypeScript, Vite, the generated FlatBuffers types, and
native browser WebRTC. The neighboring OpenArm projects informed the small
bundle, lockfile, local proxy, and browser-test workflow; no application code was copied from them. The 3D view now follows OpenArm
Teleop’s Three.js/WebGL, glTF, OrbitControls and HDR/PMREM rendering setup.
The attributed controller art is reused; all rendering code here is new.

## Run

Install Python 3, Node.js 22.18+ and pnpm 12.10.1. `dev`, `build`, `test` and
`generate` automatically prepare the pinned `flatc` compiler; see
[protocol setup](../protocol/README.md#generate-and-check). Then:

```sh
cd viewer
pnpm install --frozen-lockfile
XR_OPERATOR_URL=http://192.168.2.9:8080 pnpm dev
```

Replace the example address with the Quest's current IP. Open
`http://127.0.0.1:5173` and select **Connect**. Cancel stops an in-flight attempt;
Disconnect clears live session state. Reconnecting starts a fresh hello and
discards all callbacks and state from the previous connection.

`XR_OPERATOR_URL` defaults to `http://127.0.0.1:8080`, allowing the desktop
server (`cargo run --manifest-path operator/Cargo.toml`) to be used without a
Quest. The setting selects a single proxy destination at startup; it is not
accepted from browser requests. `/api/offer` proxies HTTP signaling, while WebRTC
data travels directly between browser and device. The browser therefore needs
LAN/VPN connectivity to the Quest; forwarding the web page alone is insufficient.
STUN/TURN and Internet deployment are not configured.

The dev and preview servers bind loopback. For a trusted LAN client, run
`pnpm dev --host 0.0.0.0`. HTTP signaling is unauthenticated, so do not expose it
to untrusted networks.

## Build and verify

```sh
pnpm test
XR_OPERATOR_URL=http://192.168.2.9:8080 pnpm build
XR_OPERATOR_URL=http://192.168.2.9:8080 pnpm preview
```

`build` generates bindings, checks all TypeScript, and bundles into `dist/`.
The endpoint label is embedded at build time, so use the same target when
building and previewing. Serving `dist/` elsewhere also requires an `/api`
reverse proxy to the device. All browser assets are local; no CDN is required.

With the Viewer and either a Quest or desktop server running:

```sh
CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:browser
# Against preview instead:
VIEWER_URL=http://127.0.0.1:4173 CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:browser
```

The browser check requires a real WebRTC endpoint. It verifies hello, discovery,
clock replies on the unreliable channel, reconnect with stable application
session identity, clearing live state on disconnect, signaling failure, and
the mobile layout. Screenshots go to repository-root `.artifacts/viewer/`.
Unit tests exercise framing, malformed and oversized packets, channel direction,
64-bit precision, rejected versions, capability limits, and zero timestamps.

Received buffers are bounds-checked before field access; generated TypeScript
accessors alone are not used as a verifier. Tracking packets before negotiation
or malformed tracking replies are discarded. Invalid control fails the connection.
All 64-bit fields stay `bigint`; the inspector renders them as decimal strings.
RTT subtracts server processing time from the local round trip. The lowest-RTT
probe estimates a clock offset for the displayed sample age; this is approximate,
not a calibrated one-way latency measurement. Resume clears the estimate.

## Recording and performance

`pnpm dev` automatically records each page load to
`.artifacts/recordings/<uuid>.jsonl` at the repository root. No separate recording
process or command is needed. A compact status badge in the **Performance** panel
shows recording activity or failure; its tooltip contains the file name,
acknowledged size or failure details. Recording runs continuously for the page's
lifetime, with best-effort flushing on page unload.

The recording contains the original FlatBuffers bytes (base64) of every sent and
received data-channel packet, including packets rejected by the decoder. It also
contains individual CPU timings, render intervals, sampled GPU timings, signaling
offers/answers, connection events, consumer-rate changes, visibility changes,
browser/Three.js versions and the source Git revision. Packets are recorded before
consumer coalescing, so a 5 Hz visualizer still records every packet received.
Each reconnect has its own connection ID within the page recording.

Browser records have a contiguous `sequence`, a `type`, and `atMs` relative to the
session's `performance.timeOrigin`. Timing records additionally have `startMs`
and `durationMs`; GPU results arrive later and refer back to the measured render.
Packet records contain `direction`, `channel`, `length` and `base64`. A sent packet
means the browser accepted `RTCDataChannel.send`, not that the Quest received it.
Clock probe/reply packets preserve the information needed to estimate clock
alignment. The file starts with a server recording header followed by a browser
session header; an acknowledged `recording-end` marks a cleanly stopped capture.

Encoding and uploads run in a Web Worker, batching every 250 ms or 256 KiB.
The dev-only `POST /__dev/recordings/<uuid>` endpoint accepts same-origin NDJSON
with `X-XR-Recording: 1` and a zero-based `X-Recording-Batch` header. It appends
ordered batches, acknowledges after writing, and deduplicates retries of the last
batch. It does not expose recordings for download over HTTP. Production builds
and `pnpm preview` have no recording endpoint and do not start disk recording.

Browser queues are limited to 4 MiB, requests to 1 MiB, and the recordings directory
to 2 GiB per dev-server instance (including existing JSONL files at startup).
Files are never automatically deleted. Move old captures elsewhere and restart
the dev server when the limit is reached. Queue overflow, write failures and
unavailable endpoints visibly mark a capture incomplete while tracking continues.
There is no guarantee that the last queued batch survives closing/crashing the
tab or server; page-unload flushing is best effort. Writes are acknowledged after
the OS accepts them, without per-batch `fsync`. Reload the Viewer after a dev-server
restart to begin a new recording.

These are browser-side observations: packets lost before reception are absent.
Quest-side acquisition/send/backpressure traces are recorded locally on the device;
retrieve them afterward using [ADB](../operator/README.md#diagnostic-recordings).

For example, inspect timing events with:

```sh
jq -c 'select(.type == "timing")' ../.artifacts/recordings/<uuid>.jsonl
```

### Viewer profiling

The **Performance** panel uses the same approach as OpenArm Teleop: a rolling
10-second chart, CPU timings from `performance.now()`, and asynchronous WebGL 2
[`EXT_disjoint_timer_query_webgl2`](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/)
GPU queries. The implementation is specific to this Viewer; no additional package
is required. Both viewers currently pin Three.js `0.186.1`.

The chart and latest/median/P95/max values run automatically. Switching browser
tab clears the chart history so background throttling does not look like a
rendering stall. Disk recording retains the individual measurements independently
of the chart's rolling window. GPU timing availability appears in the GPU row's
tooltip; the capture also records it.

- **Animation frame:** time between consecutive `requestAnimationFrame` callbacks,
  independent of incoming messages and whether the scene needs drawing.
- **Render interval:** time between actual 3D renders, including idle time.
  With continuous rendering enabled by default, this follows the display refresh
  rate (about 16.7 ms at 60 Hz). With continuous rendering off, a 5 Hz consumer
  produces intervals around 200 ms while tracking is changing.
- **Pose / Input / Body arrival interval:** time since the previous tracking message
  for that stream, measured at the next receive callback, before consumer coalescing.
  These include browser scheduling delays; they are not network latency measurements.
  The first message of a new subscription has no interval. During silence, no new
  interval is plotted; the gap appears when the next message arrives.
- **UI CPU:** dirty UI reconciliation, at most once per animation frame.
- **Poses + body CPU:** applying the latest consumed state to the scene on an animation frame.
- **Three.js CPU:** synchronous render submission; it does not wait for the GPU.
- **Message CPU:** one data-channel callback, including decoding and handling.
  DOM reconciliation is deferred to the animation-frame loop.
- **GPU render:** elapsed GPU query time around a render, sampled at most 5 Hz
  with one outstanding query. Unsupported browsers show an explicit status;
  disjoint, timed-out and context-lost samples are discarded, not reported as zero.

The **Continuous rendering** checkbox is enabled by default and draws on every animation frame, even when
the scene is unchanged. Otherwise a frame draws only if the scene is dirty.
Messages and consumer updates mark pending state; pose/body scene updates and
drawing happen on the animation-frame loop. The default **Display frame rate**
consumer takes the latest pending sample before applying and drawing it in that
same callback. Fixed 60/30/5 Hz consumers remain available for diagnostics.
Connection, inspector, recording and graphics status updates also reconcile in
that callback. Pose/input rows and their text nodes are retained, and unchanged
text/attributes are left alone. The profiler's 5 Hz timer samples transfer rates
and marks its display dirty; the next animation frame updates its tables/charts.
Packet recording and receive measurements retain their original event timing.

The separate transfer graph shows **kB/s** (1000 bytes per kB), calculated from
payload bytes in the preceding **one second**, refreshed at 5 Hz. Received and sent
totals cover both data channels; pose/input/body lines break down received tracking
traffic. Totals include received packets even if decoding rejects them; stream
lines require an accepted descriptor and valid tracking layout. Rates fall to zero
during silence, independently of the consumer. They exclude signaling, recording
uploads and WebRTC/UDP/IP overhead. Startup uses the same full one-second divisor.
Latest/median/P95/max summarize these rolling rates over the last ten seconds.
Recordings include `transfer-rate` events with `bytesPerSecond` and `windowMs`.

Performance recording is on by default in dev. The chart updates at 5 Hz and its
history is bounded. It does not force extra 3D renders. GPU sampling can miss isolated
spikes; browser layout/paint, garbage collection and other tasks outside the
instrumented callbacks require a browser DevTools Performance trace. Compare
interval spikes with the CPU/GPU rows and the existing transport statistics.
The panel measures the browser, not acquisition or rendering on the Quest.

With a running dev Viewer and tracking source, the profiling browser check exercises
default packet/timing recording, lost-acknowledgement retries, an injected
main-thread stall, slow-consumer cadence, mobile layout, unavailable
GPU timing and a failed recording endpoint. It saves results in
repository-root `.artifacts/performance/`:

```sh
CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:performance
CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:reconciliation
```

The reconciliation check uses a synthetic tracking server. It verifies retained
DOM rows/text nodes while idle and connected, suppresses unchanged text writes,
and pauses animation callbacks while reception and a 5 Hz consumer continue.
The DOM must remain unchanged until the callbacks resume. Results are saved in
`.artifacts/reconciliation/`.

## Tracking and slow-consumer test

The Viewer automatically subscribes to advertised pose, controller and body sources.
Select the stream in Tracking statistics to inspect its metrics and publication settings. Publication rate
(200/100/30/10 Hz), history (1/2/4/8), and consumption rate (display/60/30/5 Hz) are independent.
Defaults are 200 Hz server acquisition, 100 Hz publication, two samples per message,
and display-frame consumption/rendering. History is a maximum: an early publication
can contain fewer samples, and publication never waits for the history to fill.
Only the latest pending sample reaches the visualizer. The receive path records
sequence gaps, reordered/duplicate messages, sample coverage, and discarded
packets. Missing-message counts are provisional until late arrivals fill gaps;
packets older than a bounded 4,096-message reorder window count as too late.
Sample gaps include samples omitted by a lower publication rate. Viewer coalescing
is deliberate replacement of pending updates and is not transport loss.

Run `cargo run --manifest-path operator/Cargo.toml -- --synthetic-tracking`
from the repository root, then `pnpm dev --port 5174` from `viewer/`. In another
terminal in `viewer/`:

```sh
VIEWER_URL=http://127.0.0.1:5174 CHROMIUM_EXECUTABLE=/path/to/chrome pnpm test:tracking
```

This behavioral test uses the actual Connection receiver through Vite and a real
WebRTC server. It measures 200 Hz acquisition, defaults and optional 200 Hz publication,
compares concurrent fast/slow consumers, blocks one JS thread,
changes publication/history without changing acquisition, injects explicitly
labeled receiver drops, checks the desktop/mobile UI, and writes JSON measurements
and screenshots to `.artifacts/tracking/`. It requires the explicit synthetic
server; it does not claim to exercise headset tracking or Wi-Fi loss.

The spatial view renders Meta headset, Touch Plus controller and Movement body
assets using Three.js/WebGL. Drag to orbit, right-drag to pan, scroll/pinch to zoom,
or select perspective/front/side views. Keyboard arrows pan when the canvas is
focused. A joint overlay shows the received skeleton independently of the mesh.
Assets and studio HDR lighting load locally, with no runtime CDN dependency.
The 3D module loads separately from the connection UI and renders on changes.
Missing assets or unavailable WebGL leave transport controls and numeric data usable.

Controller models follow the aim frames; colored markers/axes expose the separate
grip frames. The headset is Meta’s simplified emulator asset, not a calibrated
Quest 3 enclosure. The body model is an upper-body adaptation of Meta’s Movement
sample with a neutral material. Runtime rest geometry aligns its authored A-pose;
received position and orientation deltas animate the rig. The default 70-joint
stream has no legs, so leg geometry is removed. Invalid/inactive data is hidden
and stale state fades. Mesh dimensions and retargeting are visualization aids;
use the joint overlay and numerical poses when checking physical alignment.
Headset origin, controller alignment and body retargeting still need Quest validation.

The Quest prefers OpenXR `LOCAL_FLOOR` (via `XR_EXT_local_floor`), falling back to
`LOCAL` if unavailable. The Viewer displays the advertised frame kind; metadata
ID 1 identifies the selected frame for that server session. Head, controllers and
body joints all use that same runtime frame. No guessed floor offset is applied.
The grid marks Y = 0 of that frame; it represents the estimated floor only for a
floor-based frame. The camera automatically frames newly available tracking and
the view presets frame the latest data, without changing any received coordinates.

Asset sources, licenses, exact revisions and conversion details are in
[`public/assets/SOURCES.md`](public/assets/SOURCES.md). `pnpm build:body` regenerates
the body GLB from checksum-verified upstream assets; it is not required for normal
builds. Unit tests load the actual GLB and check first-frame rigid motion, repeated
samples and invalid tracking. Browser checks exercise WebGL loading, orbit, resize,
asset failure, real tracking transport and disconnect behavior.
