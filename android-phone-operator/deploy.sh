#!/bin/sh
set -eu

cd "$(dirname "$0")"
./gradlew assembleDebug

if ! command -v adb >/dev/null 2>&1; then
    sdk_dir=$(android info sdk)
    export PATH="$sdk_dir/platform-tools:$PATH"
fi

adb install -r build/android/outputs/apk/debug/phone-operator-debug.apk
adb shell am start -n dev.xroperator.phone.experimental/dev.xroperator.phone.MainActivity
