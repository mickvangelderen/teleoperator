#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --help ]]; then
    echo 'Build an arm64 debug APK with the installed Android SDK/NDK and Rust target.'
    echo 'Usage: tools/build-apk.sh [artifact-directory]'
    echo 'Overrides: ANDROID_SDK_ROOT, ANDROID_NDK_HOME, ANDROID_BUILD_TOOLS, PHONE_DEBUG_KEYSTORE'
    exit 0
fi
sdk="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/29.0.14206865}"
bt="$sdk/build-tools/${ANDROID_BUILD_TOOLS:-36.1.0}"
platform="$sdk/platforms/android-36/android.jar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android32-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export AR_aarch64_linux_android="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
# NDK 29 and this explicit linker setting support Android 16 KiB memory pages.
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS='-C link-arg=-Wl,-z,max-page-size=16384'
cargo build --locked --lib --release --target aarch64-linux-android
rm -rf build/classes build/dex build/apk
mkdir -p build/classes build/dex build/apk/lib/arm64-v8a
javac -source 8 -target 8 -bootclasspath "$platform:$bt/core-lambda-stubs.jar" -d build/classes android/dev/xroperator/phone/MainActivity.java
mapfile -t classes < <(find build/classes -name '*.class' | sort)
"$bt/d8" --min-api 32 --lib "$platform" --output build/dex "${classes[@]}"
"$bt/aapt2" link -o build/unsigned.apk --manifest android/AndroidManifest.xml -I "$platform"
cp target/aarch64-linux-android/release/libphone_operator.so build/apk/lib/arm64-v8a/
cp build/dex/classes.dex build/apk/
(cd build/apk && zip -q -r ../unsigned.apk classes.dex lib)
"$bt/zipalign" -f -P 16 4 build/unsigned.apk build/aligned.apk
keystore="${PHONE_DEBUG_KEYSTORE:-$PWD/build/debug.keystore}"
if [[ ! -f "$keystore" ]]; then
    keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias androiddebugkey -dname 'CN=Android Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
fi
"$bt/apksigner" sign --ks "$keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out build/phone-operator-debug.apk build/aligned.apk
"$bt/apksigner" verify --verbose build/phone-operator-debug.apk
"$bt/zipalign" -c -P 16 4 build/phone-operator-debug.apk
"$bt/aapt" dump badging build/phone-operator-debug.apk
sha256sum build/phone-operator-debug.apk
if [[ -n "${1:-}" ]]; then mkdir -p "$1"; cp build/phone-operator-debug.apk "$1/phone-operator-debug.apk"; fi
