# Operator

Publishes headset and controller poses, inputs, and body joints from an Android OpenXR headset through the [teleoperation protocol](../protocol/index.md).
The [Viewer](../viewer/README.md) connects over WebRTC to inspect the tracking data.

## Usage

```sh
./deploy.sh
```

Connect the headset over USB with developer mode and USB debugging enabled.
Deployment keeps the headset awake even when it is not worn.

## Run-time dependencies

ARM64 Android API 32 or newer, with OpenXR, OpenGL ES, and `XR_FB_passthrough` support.

## Development

- Rust and Cargo through `rustup`, with Rust edition 2024 support, and a host C compiler/linker (`build-essential` on Debian/Ubuntu).
- Bash, Python 3, and a JDK such as OpenJDK 21.
- Android SDK command-line tools, with `sdkmanager`, `adb`, `java`, and `keytool` on `PATH`.

Install the Android build dependencies:

```sh
sdkmanager "platforms;android-32" "build-tools;36.1.0" "platform-tools" "ndk;29.0.14206865"
rustup target add aarch64-linux-android
cargo install cargo-apk --version 0.10.0 --locked
```

`deploy.sh` uses the SDK at `$HOME/Android/Sdk`; set `ANDROID_HOME` if it is elsewhere.

For local development without a headset or Android tooling:

```sh
cargo run -- --synthetic-tracking
```

Run unit tests with `cargo test --lib`.
