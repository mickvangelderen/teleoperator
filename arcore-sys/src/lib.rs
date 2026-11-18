//! Raw Google ARCore SDK 1.57.0 C API for Android arm64-v8a.
//!
//! Link and package libarcore_sdk_c.so from the matching com.google.ar:core AAR.
//! Maintainers can reproduce the checked-in declarations on Linux x86-64 with
//! `ANDROID_NDK_HOME=/path/to/ndk/29.0.14206865 ./arcore-sys/generate-bindings.sh`.
#![no_std]
#![allow(non_camel_case_types, non_snake_case, non_upper_case_globals)]

#[cfg(not(all(
    target_os = "android",
    target_arch = "aarch64",
    target_pointer_width = "64"
)))]
compile_error!("arcore-sys provides bindings for aarch64-linux-android only");

#[link(name = "arcore_sdk_c")]
unsafe extern "C" {}

include!("bindings.rs");
