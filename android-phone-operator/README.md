# Android Phone Operator

Use an Android phone as a handheld motion input over Wi-Fi.

## Setup

### Rust Toolchain

Use [rustup](https://rustup.rs/) and install the `stable` toolchain.
Then add the `aarch64-linux-android target`.

```sh
rustup target add aarch64-linux-android
```

We use [cargo-binstall](https://github.com/cargo-bins/cargo-binstall) to download tools from github releases:

```sh
curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash
```

We use [cargo-ndk](https://github.com/bbqsrc/cargo-ndk) to concoct android compilation commands:

```sh
cargo binstall cargo-ndk
```

### APK packaging

Install [CMake 4.5 or newer](https://cmake.org/download/) and put its `cpack`
command on your PATH. The phone app is written in Rust. CPack uses a host JDK
to package Google's ARCore library and sign the APK.

We tested the build with JDK 25, available on Ubuntu through APT.

```sh
apt install openjdk-25-jdk
```

### Android SDK

Download the [android-cli](https://developer.android.com/tools/agents/android-cli/download) to manage android skds.

> Historical note: [sdkmanager](https://developer.android.com/tools/sdkmanager) is deprecated.

```sh
curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash
```

Then install the components we need:

```sh
android sdk \
    install platforms/android-36 \
    build-tools/36.1.0 \
    ndk/29.0.14206865 \
    platform-tools
```

## Build and install

From `android-phone-operator/`, set `ANDROID_HOME` to your SDK directory.
This example uses the default Linux location.

```sh
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

Build the signed ARM64 APK. The first build downloads the ARCore SDK.

```sh
cpack --config apk.cmake
```

Connect the phone to ADB using either method.

- **USB.** Enable **USB debugging**, plug in the phone, and accept the authorization prompt.
- **Wi-Fi.** Join the same network and enable **Developer options → Wireless debugging**.
  Run `adb mdns services` to discover phones. On first use, tap **Pair device with pairing code**,
  run `adb pair IP:PAIRING_PORT` with the address shown, and enter the code.
  If the paired phone is missing from `adb devices -l`, run `adb connect IP:CONNECTION_PORT`
  using the address on the main **Wireless debugging** screen.

Once `adb devices -l` lists the phone as `device`, install or update the APK.

```sh
adb install -r build/phone-operator-debug.apk
```

## First use

Open **Phone Operator** on an ARM64 phone running Android API 32 or newer.
The app uses ARCore when available and otherwise tracks orientation with the
phone’s sensors. Connect the viewer computer to the same Wi-Fi network and set
`XR_OPERATOR_URL` in `viewer/.env.local` to the Wi-Fi URL shown in **Phone Operator**
(for example, `http://192.168.1.42:8080`). The viewer connects directly to the app.
[Viewer setup](../viewer/README.md)
