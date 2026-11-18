#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --help ]]; then
    echo 'Build the optional IMU displacement estimate APK (same IMU package, version2, port8080).'
    echo 'Usage: tools/build-imu-displacement-apk.sh [artifact-directory]'
    echo 'Overrides: ANDROID_SDK_ROOT, ANDROID_NDK_HOME, ANDROID_BUILD_TOOLS, PHONE_DEBUG_KEYSTORE'
    echo 'Set PHONE_EXPECTED_CERT_SHA256 to enforce an upgrade-compatible signing certificate.'
    echo 'Without a supplied key, creates an ignored developer key; such builds are not verified baseline upgrades.'
    exit 0
fi
sdk="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/29.0.14206865}"
bt="$sdk/build-tools/${ANDROID_BUILD_TOOLS:-36.1.0}"
platform="$sdk/platforms/android-36/android.jar"
out="$PWD/build/imu-displacement"
mkdir -p "$out"
keystore="${PHONE_DEBUG_KEYSTORE:-$out/debug.keystore}"
if [[ ! -f "$keystore" ]]; then
    if [[ -n "${PHONE_DEBUG_KEYSTORE:-}" || -n "${PHONE_EXPECTED_CERT_SHA256:-}" ]]; then
        echo 'The supplied upgrade key must already exist; no replacement key will be generated.' >&2; exit 1
    fi
    keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias androiddebugkey -dname 'CN=IMU Displacement Developer,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
fi
certificate=$(keytool -exportcert -keystore "$keystore" -alias androiddebugkey -storepass android | sha256sum | cut -d' ' -f1)
if [[ -n "${PHONE_EXPECTED_CERT_SHA256:-}" ]]; then
    expected=$(tr '[:upper:]' '[:lower:]' <<< "$PHONE_EXPECTED_CERT_SHA256")
    if [[ "$certificate" != "$expected" ]]; then echo 'Signing certificate mismatch; refusing to build an incompatible upgrade.' >&2; exit 1; fi
    echo "Verified requested signing certificate: $certificate"
else
    echo "Developer signing certificate: $certificate (baseline upgrade compatibility not verified)"
fi
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android32-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export AR_aarch64_linux_android="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384'
cargo build --locked --no-default-features --features imu-displacement --lib --release --target aarch64-linux-android --target-dir target/imu-displacement
rm -rf "$out/classes" "$out/dex" "$out/apk" "$out/generated"
mkdir -p "$out/classes" "$out/dex" "$out/apk/lib/arm64-v8a" "$out/generated"
# Reuse the reviewed widgets/lifecycle adapter; only the experiment's labels differ.
python3 - <<'PY'
from pathlib import Path
out=Path('build/imu-displacement/generated')
java=Path('android/dev/xroperator/phone/MainActivity.java').read_text()
for before,after in [('Phone Operator · Experimental','IMU displacement estimate'),('HOLD TO TRACK','HOLD TO ESTIMATE'),('TRACKING\\nRelease to stop','ESTIMATING\\nRelease to stop'),('Recenter heading (stops tracking)','Recenter heading (resets estimate)')]:
    assert before in java, before
    java=java.replace(before,after)
(out/'MainActivity.java').write_text(java)
manifest=Path('android/AndroidManifest.xml').read_text().replace('android:versionCode="1"','android:versionCode="2"').replace('0.1.0-imu','0.2.0-imu-displacement').replace('Phone Operator (IMU)','Phone IMU displacement')
(out/'AndroidManifest.xml').write_text(manifest)
PY
javac -source 8 -target 8 -bootclasspath "$platform:$bt/core-lambda-stubs.jar" -d "$out/classes" "$out/generated/MainActivity.java"
mapfile -t classes < <(find "$out/classes" -name '*.class' | sort)
"$bt/d8" --min-api 32 --lib "$platform" --output "$out/dex" "${classes[@]}"
"$bt/aapt2" link -o "$out/unsigned.apk" --manifest "$out/generated/AndroidManifest.xml" -I "$platform"
cp target/imu-displacement/aarch64-linux-android/release/libphone_operator.so "$out/apk/lib/arm64-v8a/"
cp "$out/dex/classes.dex" "$out/apk/"
(cd "$out/apk" && zip -q -r ../unsigned.apk classes.dex lib)
"$bt/zipalign" -f -P 16 4 "$out/unsigned.apk" "$out/aligned.apk"
"$bt/apksigner" sign --ks "$keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$out/phone-operator-imu-displacement-debug.apk" "$out/aligned.apk"
"$bt/apksigner" verify --verbose --print-certs "$out/phone-operator-imu-displacement-debug.apk"
"$bt/zipalign" -c -P 16 4 "$out/phone-operator-imu-displacement-debug.apk"
sha256sum "$out/phone-operator-imu-displacement-debug.apk"
if [[ -n "${1:-}" ]]; then mkdir -p "$1"; cp "$out/phone-operator-imu-displacement-debug.apk" "$1/phone-operator-imu-displacement-debug.apk"; fi
