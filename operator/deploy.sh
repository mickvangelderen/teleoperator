#!/usr/bin/env bash

set -eou pipefail

export ANDROID_HOME="${ANDROID_HOME-$HOME/Android/Sdk}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME-$ANDROID_HOME/ndk/29.0.14206865}"

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if [[ -n ${ANDROID_SERIAL:-} ]]; then
    quest_serial=$ANDROID_SERIAL
elif ! quest_serial=$(adb -d get-serialno 2> /dev/null); then
    quest_serial=$(adb mdns services | awk '$2 == "_adb-tls-connect._tcp" { print $1 "." $2 }')
    adb connect "$quest_serial"
fi
export ANDROID_SERIAL="$quest_serial"

adb shell settings put global adb_wifi_enabled 1
adb shell am broadcast -a com.oculus.vrpowermanager.prox_close
adb shell input keyevent KEYCODE_WAKEUP
python3 prepare-loader.py
cargo apk build --lib
adb install target/debug/apk/xr-operator.apk
printf '%s\n' 'Warning: If the next command hangs, check the headset for a pending approval prompt.' >&2
adb shell am start-activity -W dev.xroperator.quest/android.app.NativeActivity
