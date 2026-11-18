# Android Phone Operator

Use an Android phone as a handheld motion input over Wi-Fi.

## Setup

Build on Linux x86_64 with Rust/rustup, a JDK (`java`, `javac`, `keytool`),
Python 3, curl, zip and unzip. In Android SDK Manager, install platform-tools,
Android SDK Platform 36, Build-Tools 36.1.0 and NDK 29.0.14206865.
The phone must support arm64 apps and Android API 32 or later.

From the repository root, enter the project directory and prepare the Rust target:

```sh
cd android-phone-operator
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
export PATH="$ANDROID_SDK_ROOT/platform-tools:$PATH"
rustup target add aarch64-linux-android
```

Set `ANDROID_SDK_ROOT` to your SDK location if it differs from the default above.
Enable USB debugging on the phone, connect it by USB and authorize the computer.

## Build and install

Choose one variant. These commands build, install or update, and launch it.

**IMU baseline:** orientation only; no camera required.

```sh
./tools/build-apk.sh
adb install -r build/phone-operator-debug.apk
adb shell am start -n dev.xroperator.phone.experimental/dev.xroperator.phone.MainActivity
```

**IMU displacement (optional):** adds an uncorrected position estimate that
drifts; each hold starts with zero displacement and assumed zero velocity.

The displacement app replaces the baseline. If upgrading a baseline built
with the defaults above, first select its existing signing key:

```sh
export PHONE_DEBUG_KEYSTORE="$PWD/build/debug.keystore"
```

For a fresh install, no key override is needed. Then build and install:

```sh
./tools/build-imu-displacement-apk.sh
adb install -r build/imu-displacement/phone-operator-imu-displacement-debug.apk
adb shell am start -n dev.xroperator.phone.experimental/dev.xroperator.phone.MainActivity
```

Keep the key used for an installed app: updates require the same key. The two
IMU build scripts create separate debug keys by default. Returning from
displacement to the baseline requires a supported downgrade (`adb install -r -d`)
or uninstalling the app first; uninstalling removes its data.

**ARCore (optional):** camera-assisted position and orientation; installs
alongside either IMU variant. Requires an ARCore-supported phone.

```sh
./tools/build-arcore-apk.sh
adb install -r build/arcore/phone-operator-arcore-debug.apk
adb shell am start -n dev.xroperator.phone.arcore.experimental/dev.xroperator.phone.MainActivity
```

Allow camera access and complete any Google Play Services for AR install/update
prompt. Keep the app open, connect the phone and client to the same Wi-Fi, and
use the address shown in the app. Select Left or Right, recenter, then hold to
send motion; release to stop.
