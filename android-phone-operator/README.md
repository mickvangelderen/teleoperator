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

The Gradle Wrapper needs a host JDK. We tested the build with JDK 25,
available on Ubuntu through APT.

```sh
apt install openjdk-25-jdk
```

### Android SDK

Install the [Android CLI](https://developer.android.com/tools/agents/android-cli/download) to manage the shared Android SDK.

> Historical note: [sdkmanager](https://developer.android.com/tools/sdkmanager) is deprecated.

```sh
curl -fsSL https://dl.google.com/android/cli/latest/linux_x86_64/install.sh | bash
```

## Build and install

With your phone connected to ADB, run this from `android-phone-operator/` to
rebuild, install, and launch Phone Operator.

```sh
./deploy.sh
```

To build the signed ARM64 APK on its own, use the Gradle Wrapper. The build uses
the SDK reported by `android info sdk` and asks the CLI to install any missing
packages there. The wrapper downloads Gradle and the build dependencies on first use.

```sh
./gradlew assembleDebug
```

If your shell cannot find `adb`, add the SDK's platform tools to your path.

```sh
export PATH="$(android info sdk)/platform-tools:$PATH"
```

Connect the phone to ADB using either method.

- **USB.** Enable **USB debugging**, plug in the phone, and accept the authorization prompt.
- **Wi-Fi.** Connect the phone and computer to the same Wi-Fi network. On the phone,
  open **Developer options**, enable **Wireless debugging**, then tap the **Wireless debugging**
  row to open its settings.

  1. **Pair once per computer.** If the computer is already paired, skip to step 2.
     Tap **Pair device with pairing code** to display the six-digit code. Leave that
     dialog open. If it shows an mDNS hostname, list the services on the computer.

     ```sh
     adb mdns services
     ```

     For `IP:PAIRING_PORT`, use the IP and port in the dialog or copy them
     from the phone's `_adb-tls-pairing._tcp` row. Enter the six-digit code in
     the terminal when prompted.

     ```sh
     adb pair IP:PAIRING_PORT
     ```

  2. **Check the connection.** On the computer, list connected devices.

     ```sh
     adb devices -l
     ```

     If the phone is missing, return to the main **Wireless debugging** screen.
     Use the **IP address & port** shown there, or copy the IP and port from
     the phone's `_adb-tls-connect._tcp` row in the mDNS service list.

     ```sh
     adb connect IP:CONNECTION_PORT
     ```

Once ADB lists the phone as `device`, install or update the APK.

```sh
adb install -r build/android/outputs/apk/debug/phone-operator-debug.apk
```

Launch **Phone Operator** from the same terminal.

```sh
adb shell am start -n dev.xroperator.phone.experimental/dev.xroperator.phone.MainActivity
```

## First use

Open **Phone Operator** on an ARM64 phone running Android API 32 or newer.
The app uses ARCore when available and otherwise tracks orientation with the
phone’s sensors. Connect the viewer computer to the same Wi-Fi network and set
`XR_OPERATOR_URL` in `viewer/.env.local` to the Wi-Fi URL shown in **Phone Operator**
(for example, `http://192.168.1.42:8080`). The viewer connects directly to the app.
[Viewer setup](../viewer/README.md)
