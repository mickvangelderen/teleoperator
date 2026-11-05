# Operator

Rust Android application for Meta Quest 3. The roadmap is in [IDEA.md](../IDEA.md).

The application is built as an ARM64 shared library and packaged with
`cargo-apk`. It runs an HTTP signaling endpoint on **port 8080** and a WebRTC
data-channel server alongside an immersive OpenXR session with passthrough.
Head and left/right controller grip and aim poses are acquired at 200 Hz in the
runtime's Local Floor space when available, with an explicitly advertised Local
fallback. Each sample retains independent position/orientation validity, tracking,
and controller activity flags. Unavailable tracking is never replaced with fake
headset data. A second stream exposes 27 controller inputs, including runtime
Boolean conversions for trigger/grip presses, touch states, thumbsticks, face
buttons and the left menu button. The body stream exposes the default 70-joint
OpenXR body set, confidence, activity, versioned skeleton geometry, and actual
fidelity/calibration status when the runtime supplies them. Body capability is
advertised only after the runtime has returned a valid skeleton.

The server implements hello, capability discovery, clock probes, protocol v2 tracking
subscribe, publication changes, and unsubscribe. A stream's selection is immutable.
All clients currently share one 200 Hz acquisition history and physical input
counters; publication filters each stream's selected sources independently. This is
the current implementation, not a universal acquisition boundary for XR devices.
The [protocol design](../protocol/PROTOCOL.md) defines the device-independent
requirements; [wire status](../protocol/README.md#design-and-implementation-status)
records the acquisition-group work still needed. See
[supported settings](#body-permission-and-supported-settings) for current choices
and [tracking validation](TRACKING.md) for historical measurements.

## Threads and lifecycle

The backend has three threads: `android_main` handles Android lifecycle and input
queues; `xr` owns EGL, OpenXR events, session lifecycle and the frame loop;
`xr-acquisition` samples at 200 Hz, independently of display rate, waiting for
commands or absolute deadlines and skipping missed slots.

A zero-capacity command channel synchronizes lifecycle changes between samples.
Session begin completes before acquisition starts; pause stops XR queries before
session end and publishes one inactive sample. Publishers have their own send
deadlines. Dropping the command sender stops acquisition, which is joined before
XR resources and EGL are destroyed. Android Destroy stops and joins the XR thread.
Normal XR termination wakes Android to close the activity and networking; XR errors
leave signaling available until Android Destroy.
There is no shared acquisition/frame mutex; history keeps its own lock.

OpenXR events are serviced between frames, or every 20 ms while idle.
`xrWaitFrame` blocks only the XR thread; shutdown still depends on it returning.
Session begin/end stay with EGL because Quest initializes GL entry points during
`xrBeginSession`. Independent body and controller acquisition groups remain future
protocol work.

## Build

Install Python 3, Rust through rustup,
a JDK (tested with OpenJDK 21), and the Android SDK
with Platform 32, Build Tools 36.1.0, Platform Tools, and NDK 29.0.14206865.
With the Android SDK command-line tools on your PATH:

```sh
sdkmanager "platforms;android-32" "build-tools;36.1.0" "platform-tools" "ndk;29.0.14206865"
rustup target add aarch64-linux-android
cargo install cargo-apk --version 0.10.0 --locked
```

Run the following commands from `operator/`. Point these variables at your SDK
installation, then build:

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/29.0.14206865"
python3 prepare-loader.py
cargo apk build --lib
```

The APK is `target/debug/apk/xr-operator.apk`. `cargo-apk` signs debug builds
with the local Android debug keystore (`~/.android/debug.keystore`), creating
it if needed. Do not use that key for distribution.

Cargo automatically prepares the pinned host `flatc` compiler for both Android
and desktop builds. No system `flatc` installation or `FLATC` setting is needed;
see [protocol setup](../protocol/README.md#generate-and-check) for caching and overrides.

## Deploy to Quest 3

Enable developer mode and USB debugging on the headset, connect a USB data
cable, and accept its USB debugging authorization prompt. Keep the headset
awake. `adb devices -l` must show it as `device`, not `unauthorized` or `offline`.
Ensure the SDK's `platform-tools/` directory is on your PATH.

Build, install, and launch:

```sh
./deploy.sh
```

The script defaults to the SDK paths above when `ANDROID_HOME` or
`ANDROID_NDK_HOME` is unset, preserving any existing values.

The script updates the installed app while preserving its data. It prefers USB;
otherwise, it discovers and connects to modern wireless ADB through mDNS.
To select a device explicitly, use `ANDROID_SERIAL=YOUR_QUEST_SERIAL ./deploy.sh`.
Wireless ADB must already be enabled and authorized in the headset's developer
settings. USB deployment leaves that setting unchanged, so it does not open a
wireless-debugging permission dialog.

The script overrides proximity detection to treat the headset as worn and wakes
it, keeping it active off-head. This also keeps the display awake.

To stream the app's logs:

```sh
adb -s YOUR_QUEST_SERIAL logcat 'xr-operator:I' '*:S'
```

## Diagnostic recordings

The operator records diagnostics locally by default, independently of the Viewer.
On Quest the files are in the app's private `files/diagnostics/` directory. Pull
them after reproducing a hiccup; no live collector is needed:

```sh
mkdir -p ../.artifacts/quest-diagnostics
adb -s YOUR_QUEST_SERIAL exec-out run-as dev.xroperator.quest \
  tar -C files -cf - diagnostics > ../.artifacts/quest-diagnostics/capture.tar
tar -xf ../.artifacts/quest-diagnostics/capture.tar -C ../.artifacts/quest-diagnostics
```

`run-as` works with the debug APK built above. `trace.0.jsonl` is current;
`trace.1.jsonl` through `trace.3.jsonl` are older, newest first. Each file has a
session header matching the WebRTC ServerHello session ID (high then low, hex).
Timestamps are milliseconds in Hub's monotonic epoch; divide wire acquisition
and clock-reply nanoseconds by 1,000,000 to compare. Match tracking events to
Viewer packets by session, stream ID and message number. Retrieval while running
can include an unfinished last line; the copied files remain usable up to it.

Each collected sample produces one `acquisition` record using its existing sample
number and acquisition timestamp (`acquired_ms`, converted from nanoseconds).
This preserves the acquisition cadence even for samples that never reach a Viewer.
The record's `at_ms` marks completion of storing the sample in the shared history.

`packet` records contain the exact wire bytes in base64 `data`, plus `peer`,
`channel`, `buffered_bytes` and an `action`: `receive`, `send` or `skip-buffer`.
Outgoing packets are recorded before the send/drop decision, including their
existing sample values, sample numbers and acquisition timestamps. Control
packets retain the stream descriptors and metadata needed to decode them.
`send` means a send attempt, not proof of delivery. Skipped packets are retained
too; an unsuccessful publication does not consume a message number.

Compare a client's missing/late packets with this pre-transmission recording:
regular acquisition with late client arrival points downstream of acquisition;
gaps in acquisition timestamps point to the producer. `skip-buffer` distinguishes
the application's 64 KiB backpressure cutoff from packets passed to WebRTC.
An acquisition record keeps the sampling cadence visible even when publication
stalls or deliberately omits samples. Full sample values are retained for
prepared packets; acquisition markers alone do not contain those values.

Serialization and file writes run on a dedicated thread. A 1,024-event queue
uses nonblocking submission; `dropped_events` and sequence gaps identify lost
diagnostics if the writer cannot keep up. Recording failures go to logcat.
Four 64 MiB files bound storage to 256 MiB; rotation and app restarts replace the
oldest files, so pull a capture before further testing overwrites it. Buffered
writes flush at least once per second and on clean shutdown. A crash or forced
stop can lose the latest buffered data. Desktop runs use
repository-root `.artifacts/operator-recordings/` with the same format.

## Desktop development and tests

The same server runs on the host, without Android or hardware:

```sh
cargo run
# Explicit synthetic poses over the same protocol and publisher:
cargo run -- --synthetic-tracking
cargo test
cargo clippy --all-targets -- -D warnings
```

It binds `127.0.0.1:8080` by default. Override with `XR_OPERATOR_BIND=IP:PORT`
when needed. Ctrl+C closes the listener and peers. The Quest binds `0.0.0.0:8080`
and closes networking when the activity is destroyed or OpenXR requests exit.
Pausing the XR session does not shut down networking. Samples become invalid or
inactive while the runtime is unavailable. Resume invalidates clock mapping and
starts another reference-space version.

## Transport

- `GET /health` reports source provenance and tracking availability.
- `GET /stats` reports accepted sends, backpressure skips, send errors, bytes, and
  peak buffered bytes for the latest 64 streams. Counters are decimal strings.
  Publishing wakes on acquisition, control changes, or a pending send deadline, orders controller/pose/body,
  and budgets each complete sample packet against a 64 KiB buffered-byte ceiling.
  This permits history-eight body packets; it does not isolate streams from shared
  SCTP congestion. A publication deadline is armed only when a fresh sample is pending.
- `POST /offer` takes JSON `{ "type": "offer", "sdp": "..." }` and returns an
  answer with gathered host ICE candidates. Both endpoints gather completely;
  there is no trickle endpoint. Requests and protocol packets are limited to 64 KiB.
- The browser opens in-band channels named `control` (reliable, ordered) and
  `tracking` (unordered, `maxRetransmits: 0`), both with subprotocol `xrop`.
  The server verifies delivery settings and rejects extra/duplicate channels.
- Each peer negotiates independently. The random 128-bit server session ID is
  shared across peers and changes when the application server restarts.
- At most four peers and three streams per peer are supported. Incomplete handshakes
  expire after 20 seconds; malformed control, channel closure, and failed/disconnected
  ICE close the peer.
  Control request IDs must increase. Probes are matched by the client; neither
  namespace has a lifetime request budget.
- This is a trusted-LAN development endpoint: no authentication, TLS signaling,
  STUN, or TURN. Keep port 8080 private. The Viewer proxies signaling on its own
  origin; the device rejects direct requests carrying an Origin header.
  WebRTC encrypts the established data channels, but HTTP signaling does not
  authenticate the remote endpoint.

The transport is pinned to webrtc-rs **0.17.2**. Quest/Chromium tests of 0.21.1
found missing remote DCEP retransmission metadata, and intermittent loss of the
first message with pre-negotiated channels. Recheck these behaviors before
changing the dependency. No upstream source is vendored or modified.

## Body permission and supported settings

On first launch the app requests `com.oculus.permission.BODY_TRACKING` using
Android's permission UI. Grant it in the headset. Denial leaves head/controller
tracking available; body discovery appears after permission and skeleton acquisition
succeed. Revoking permission closes body streams without closing pose/input streams.
The Viewer resubscribes on restored capability discovery in the same connection.
Explicitly unsubscribed streams remain stopped until reconnect.

OpenXR actions and bindings are prepared at startup; network selections do not
create new actions. The current implementation uses 200 Hz acquisition, one runtime
reference space (Local Floor when supported, otherwise Local), acquisition-time
targeting, the default 70-joint FB body set (upper body and hands), and the runtime's
default fidelity preference. Capabilities reports the acquisition rate, actual space
kind, and available sources/joint set. Full 84-joint tracking, selectable fidelity,
velocity channels, application hysteresis and Touch Plus extras are not advertised. Consumers
can choose 1–200 Hz publication and 1–8 historical samples independently for each
stream. The default is 100 Hz publication with up to two samples per message;
publication never waits to fill history. The 200 Hz sampler polls the OpenXR
runtime every 5 ms; this does not imply that each sensor or body estimate updates
at that frequency. The spatial Viewer uses attributed Meta models and an optional received-joint overlay.

Hub retains eight complete ticks even with no subscribers. Each tick contains pose,
input, and optional body data with one sample number and acquisition timestamp.
Streams filter that history rather than owning acquisition buffers. Body history
stops at the latest gap in body availability. These storage and scheduling choices
must change to support independently acquired groups; lowering a stream's publication
rate currently does not reduce acquisition work.

The current wire uses reference-space ID 1 and skeleton ID 2. Recenter increments
the reference version without transmitting a continuity transform. The body backend
validates 70 joints and finite rest geometry, and refetches/reversions the skeleton
on runtime skeleton changes or recenter. The recorded rest geometry's exact headset
space convention still needs physical validation. These are backend choices and
validation status, not requirements on other devices.

Runtime target, returned-body and input-change timestamps are currently absent,
not raw `XrTime` values mislabeled as server time. Acquisition timestamps and clock
probes use Hub's shared session-relative monotonic epoch, not raw CLOCK_MONOTONIC. Exact runtime-time conversion and the
skeleton coordinate convention need Quest validation before enabling those fields.
See the [Khronos skeleton joint reference](https://registry.khronos.org/OpenXR/specs/1.1/man/html/XrBodySkeletonJointFB.html)
for the API's stated base-space convention.
