# Operator

Rust Android application for Meta Quest 3. The roadmap is in [IDEA.md](../IDEA.md).

The application is built as an ARM64 shared library and packaged with
`cargo-apk`. It runs an HTTP signaling endpoint on **port 8080** and a WebRTC
data-channel server alongside an immersive OpenXR session with passthrough.
Head and left/right controller grip and aim poses are acquired at 100 Hz in Local
space. Each sample retains independent position/orientation validity, tracking,
and controller activity flags. Unavailable tracking is never replaced with fake
headset data. Controller inputs and body samples are not implemented yet.

The protocol implements hello, capability discovery, clock probes, pose subscribe,
replacement, publication changes, and unsubscribe. Identical acquisition requests
share a subscription; publication is independent per client. See
[tracking validation](TRACKING.md) for the supported settings and test results.

## Build

Install [flatc 25.9.23](../protocol/README.md#generate-and-check), Rust through rustup,
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
Deploy over USB once to enable wireless debugging, accepting the headset's
network authorization prompt if shown. Subsequent deployments can use Wi-Fi.

The script overrides proximity detection to treat the headset as worn and wakes
it, keeping it active off-head. This also keeps the display awake.

To stream the app's logs:

```sh
adb -s YOUR_QUEST_SERIAL logcat 'xr-operator:I' '*:S'
```

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
and closes networking when the activity is destroyed. Pausing the XR session does not shut down networking. Samples become invalid or
inactive while the runtime is unavailable. Resume invalidates clock mapping and
starts another Local reference-space version.

## Transport

- `GET /health` reports source provenance and tracking availability.
- `GET /stats` reports accepted sends, backpressure skips, send errors, bytes, and
  peak buffered bytes for the latest 64 streams. Counters are decimal strings.
- `POST /offer` takes JSON `{ "type": "offer", "sdp": "..." }` and returns an
  answer with gathered host ICE candidates. Both endpoints gather completely;
  there is no trickle endpoint. Requests and protocol packets are limited to 64 KiB.
- The browser opens in-band channels named `control` (reliable, ordered) and
  `tracking` (unordered, `maxRetransmits: 0`), both with subprotocol `xrop`.
  The server verifies delivery settings and rejects extra/duplicate channels.
- Each peer negotiates independently. The random 128-bit server session ID is
  shared across peers and changes when the application server restarts.
- At most four peers are retained. Incomplete handshakes expire after 20 seconds;
  malformed control, channel closure, and failed/disconnected ICE close the peer.
  Control request and clock probe deduplication each have a 65,536-ID budget per
  connection. The Viewer requests reconnect after exhausting its probe budget.
- This is a trusted-LAN development endpoint: no authentication, TLS signaling,
  STUN, or TURN. Keep port 8080 private. The Viewer proxies signaling on its own
  origin; the device rejects direct requests carrying an Origin header.
  WebRTC encrypts the established data channels, but HTTP signaling does not
  authenticate the remote endpoint.

The transport is pinned to webrtc-rs **0.17.2**. Quest/Chromium tests of 0.21.1
found missing remote DCEP retransmission metadata, and intermittent loss of the
first message with pre-negotiated channels. Recheck these behaviors before
changing the dependency. No upstream source is vendored or modified.
