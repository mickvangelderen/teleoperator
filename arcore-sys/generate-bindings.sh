#!/usr/bin/env bash
set -euo pipefail

crate=$(cd "$(dirname "$0")" && pwd)
ANDROID_NDK_HOME=$(realpath "${ANDROID_NDK_HOME:?Point ANDROID_NDK_HOME at Android NDK 29.0.14206865}")
export ANDROID_NDK_HOME
if ! grep -Eq '^Pkg.Revision *= *29\.0\.14206865[[:space:]]*$' "$ANDROID_NDK_HOME/source.properties"; then
    echo "Expected NDK 29.0.14206865" >&2
    exit 1
fi
export LIBCLANG_PATH="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/lib"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
# google-ar/arcore-android-sdk tag v1.57.0
revision=204ddfd1715eb0cb775bf7528c9aee9d93cd4d4a
curl -fsSL "https://raw.githubusercontent.com/google-ar/arcore-android-sdk/$revision/libraries/include/arcore_c_api.h" -o arcore_c_api.h
echo '0dfc2ae3f70acaca7b1fa28e9303a2ce8f1212836809f21306e9226a4d383b50  arcore_c_api.h' | sha256sum -c -
cargo run --locked --manifest-path "$crate/generator/Cargo.toml"
cp bindings.rs "$crate/src/bindings.rs"
