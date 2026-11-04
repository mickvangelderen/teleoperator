#!/usr/bin/env bash

set -eou pipefail

export ANDROID_HOME="${ANDROID_HOME-$HOME/Android/Sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME-$ANDROID_HOME/ndk/29.0.14206865}"

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

adb get-state > /dev/null
cargo apk build
adb install target/debug/apk/xr-operator.apk
adb shell am start-activity -W dev.xroperator.quest/android.app.NativeActivity
