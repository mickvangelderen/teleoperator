# Operator

Rust Android application for Meta Quest 3. The roadmap is in [IDEA.md](../IDEA.md).

The application is built as an ARM64 shared library and packaged with
`cargo-apk`. This bootstrap only runs the Android
lifecycle loop and writes to logcat. It opens an empty Android panel; OpenXR,
passthrough, networking, and tracking belong to later steps.

## Build

Install Rust through rustup, a JDK (tested with OpenJDK 21), and the Android SDK
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
cargo apk build
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
