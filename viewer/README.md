# Viewer

Read-only TypeScript interface for XR Operator. It displays the live hello
exchange, full-width session identity, advertised capabilities, channel state,
clock-probe round-trip time, message sizes, and decoded payloads. The spatial
workspace renders head and controller poses, controller input states and cumulative
transition counts, their validity/activity, and per-stream
statistics. An explicit desktop synthetic source is labeled in the Viewer; the
Viewer never invents poses when the headset is unavailable.

The frontend uses pnpm, TypeScript, Vite, the generated FlatBuffers types, and
native browser WebRTC. The neighboring OpenArm projects informed the small
bundle, lockfile, local proxy, and browser-test workflow; no code or assets were
copied from them. No Python server, UI framework, or 3D dependency is needed for
this milestone.

## Run

Install Node.js 22.18+ and pnpm 12.10.1, plus
[flatc 25.9.23](../protocol/README.md#generate-and-check). Then:

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

## Tracking and slow-consumer test

The Viewer automatically subscribes to advertised pose and controller sources.
Select the stream in Tracking statistics to inspect its metrics and publication settings. Publication rate
(100/30/10 Hz), history (1/4/8), and consumption rate (60/30/5 Hz) are independent.
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
WebRTC server. It compares concurrent fast/slow consumers, blocks one JS thread,
changes publication/history without changing acquisition, injects explicitly
labeled receiver drops, checks the desktop/mobile UI, and writes JSON measurements
and screenshots to `.artifacts/tracking/`. It requires the explicit synthetic
server; it does not claim to exercise headset tracking or Wi-Fi loss.
