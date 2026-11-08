# Operator

A server implementation of the teleoperation protocol for Android-based OpenXR devices.

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

## Deploy to Quest 3

Enable developer mode and USB debugging on the headset, connect a USB data
cable, and accept its USB debugging authorization prompt. Keep the headset
awake. `adb devices -l` must show it as `device`, not `unauthorized` or `offline`.
Ensure the SDK's `platform-tools/` directory is on your PATH.

Build, install, and launch:

```sh
./deploy.sh
```

The script overrides proximity detection to treat the headset as worn and wakes
it, keeping it active off-head. This also keeps the display awake.

To stream the app's logs:

## Diagnostic recordings

The operator records diagnostics locally by default, independently of the Viewer.
On Quest the files are in the app's private `files/diagnostics/` directory. 

```sh
mkdir -p ../.artifacts/quest-diagnostics
adb -s YOUR_QUEST_SERIAL exec-out run-as dev.xroperator.quest \
  tar -C files -cf - diagnostics > ../.artifacts/quest-diagnostics/capture.tar
tar -xf ../.artifacts/quest-diagnostics/capture.tar -C ../.artifacts/quest-diagnostics
```

## Body permission and supported settings

On first launch the app requests `com.oculus.permission.BODY_TRACKING` using
Android's permission UI. Grant it in the headset.
