#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${1:-}" == --help ]]; then
    echo 'Build the separate experimental ARCore arm64 APK (package .arcore.experimental, port 8081).'
    echo 'Usage: tools/build-arcore-apk.sh [artifact-directory]'
    echo 'Requires Android SDK/NDK, Rust Android target, Java, curl, unzip, zip and Python 3.'
    echo 'Overrides: ANDROID_SDK_ROOT, ANDROID_NDK_HOME, ANDROID_BUILD_TOOLS, PHONE_ARCORE_KEYSTORE'
    echo 'Output: build/arcore/phone-operator-arcore-debug.apk; never modifies the IMU APK/key.'
    exit 0
fi
sdk="${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}"
ndk="${ANDROID_NDK_HOME:-$sdk/ndk/29.0.14206865}"
bt="$sdk/build-tools/${ANDROID_BUILD_TOOLS:-36.1.0}"
platform="$sdk/platforms/android-36/android.jar"
out="$PWD/build/arcore"
deps="$PWD/build/arcore-sdk"
mkdir -p "$out" "$deps"
fetch() {
    local url="$1" path="$2" sha="$3"
    if [[ ! -f "$path" ]]; then curl -fL --retry 3 "$url" -o "$path.tmp"; mv "$path.tmp" "$path"; fi
    echo "$sha  $path" | sha256sum -c -
}
# Actual official artifacts, pinned bytes; see ARCore Additional Terms of Service.
fetch https://dl.google.com/dl/android/maven2/com/google/ar/core/1.57.0/core-1.57.0.aar "$deps/core-1.57.0.aar" df53bb8ea8e3a9f32e256b91909959d60b2e4c60d8fcc56b905b4c3e926f5c72
fetch https://raw.githubusercontent.com/google-ar/arcore-android-sdk/1.57.0/libraries/include/arcore_c_api.h "$deps/arcore_c_api.h" 0dfc2ae3f70acaca7b1fa28e9303a2ce8f1212836809f21306e9226a4d383b50
fetch https://dl.google.com/dl/android/maven2/androidx/annotation/annotation/1.3.0/annotation-1.3.0.jar "$deps/annotation-1.3.0.jar" 97dc45afefe3a1e421da42b8b6e9f90491477c45fc6178203e3a5e8a05ee8553
unzip -qo "$deps/core-1.57.0.aar" -d "$deps/aar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android32-clang"
export CC_aarch64_linux_android="$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER"
export AR_aarch64_linux_android="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
export CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS="-C link-arg=-Wl,-z,max-page-size=16384 -L native=$deps/aar/jni/arm64-v8a"
"$CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER" -std=c11 -fsyntax-only -I "$deps" tools/check-arcore-abi.c
# Distinct Cargo target directory also preserves baseline native build outputs.
cargo build --locked --features arcore --lib --release --target aarch64-linux-android --target-dir target/arcore
rm -rf "$out/classes" "$out/dex" "$out/apk" "$out/generated"
mkdir -p "$out/classes" "$out/dex" "$out/apk/lib/arm64-v8a" "$out/generated"
"$bt/aapt2" compile --dir "$deps/aar/res" -o "$out/resources.zip"
"$bt/aapt2" link -o "$out/unsigned.apk" --manifest android-arcore/AndroidManifest.xml -I "$platform" --java "$out/generated" --extra-packages com.google.ar.core "$out/resources.zip"
mapfile -t generated < <(find "$out/generated" -name '*.java' | sort)
javac -source 8 -target 8 -bootclasspath "$platform:$bt/core-lambda-stubs.jar" -d "$out/classes" android-arcore/dev/xroperator/phone/MainActivity.java "${generated[@]}"
mapfile -t classes < <(find "$out/classes" -name '*.class' | sort)
"$bt/d8" --min-api 32 --lib "$platform" --output "$out/dex" "$deps/aar/classes.jar" "$deps/annotation-1.3.0.jar" "${classes[@]}"
cp target/arcore/aarch64-linux-android/release/libphone_operator.so "$out/apk/lib/arm64-v8a/"
cp "$deps/aar/jni/arm64-v8a/"*.so "$out/apk/lib/arm64-v8a/"
cp "$out/dex/"*.dex "$out/apk/"
(cd "$out/apk" && zip -q -r ../unsigned.apk .)
"$bt/zipalign" -f -P 16 4 "$out/unsigned.apk" "$out/aligned.apk"
keystore="${PHONE_ARCORE_KEYSTORE:-$out/debug.keystore}"
if [[ ! -f "$keystore" ]]; then
    keytool -genkeypair -keystore "$keystore" -storepass android -keypass android -alias androiddebugkey -dname 'CN=ARCore Experimental Debug,O=Android,C=US' -keyalg RSA -keysize 2048 -validity 10000
fi
"$bt/apksigner" sign --ks "$keystore" --ks-key-alias androiddebugkey --ks-pass pass:android --key-pass pass:android --out "$out/phone-operator-arcore-debug.apk" "$out/aligned.apk"
"$bt/apksigner" verify --verbose "$out/phone-operator-arcore-debug.apk"
"$bt/zipalign" -c -P 16 4 "$out/phone-operator-arcore-debug.apk"
sha256sum "$out/phone-operator-arcore-debug.apk"
if [[ -n "${1:-}" ]]; then mkdir -p "$1"; cp "$out/phone-operator-arcore-debug.apk" "$1/phone-operator-arcore-debug.apk"; fi
