#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
./gradlew assembleDebug

if ! command -v adb >/dev/null 2>&1; then
    sdk_dir=$(android info sdk)
    export PATH="$sdk_dir/platform-tools:$PATH"
fi

# A paired phone advertises the same service name when its TCP port changes.
connect_type=_adb-tls-connect._tcp
wifi_services() {
    adb mdns services | awk -v type="$connect_type" -v endpoint="${1:-}" \
        '$2 == type && (!endpoint || $3 == endpoint) { print $1 "." type }' | sort -u
}

target=${ANDROID_SERIAL:-}
if [[ -z $target ]]; then
    target=$(adb devices | awk '$2 == "device" && $1 !~ /^emulator-[0-9]+$/ { print $1 }')
    if [[ -z $target ]]; then target=$(wifi_services); fi
    if [[ -z $target ]]; then
        echo 'No ready ADB device or Wi-Fi connection service. Check USB or enable Wireless debugging on the paired phone.' >&2
        exit 1
    elif [[ $target == *$'\n'* ]]; then
        printf 'Multiple ADB targets. Set ANDROID_SERIAL to one of these:\n%s\n' "$target" >&2
        exit 1
    fi
fi

service=
case $target in
    *."$connect_type") service=$target ;;
    *:*) # Remember an existing manual TCP connection by its exact advertised endpoint.
        service=$(wifi_services "$target") || service=
        if [[ $service == *$'\n'* ]]; then service=; fi ;;
esac

ready() { [[ $(adb -s "$target" get-state 2>/dev/null) == device ]]; }
connect_phone() {
    target=$service
    adb connect "$target"
    ready || { echo "ADB connection to $target is not ready. Check pairing and Wireless debugging." >&2; return 1; }
}

if [[ -n $service ]] && ! ready; then connect_phone; fi
printf 'Deploying to %s\n' "$target"
adb -s "$target" install -r build/android/outputs/apk/debug/phone-operator-debug.apk

launch() {
    adb -s "$target" shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
        -n dev.xroperator.phone.experimental/dev.xroperator.phone.MainActivity
}
if launch; then exit 0; else result=$?; fi
if [[ -z $service ]] || ready; then exit "$result"; fi
connect_phone
launch
