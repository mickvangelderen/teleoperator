use std::{env, path::PathBuf};

fn main() {
    let ndk = PathBuf::from(env::var_os("ANDROID_NDK_HOME").unwrap());
    let llvm = ndk.join("toolchains/llvm/prebuilt/linux-x86_64");
    bindgen::Builder::default()
        .header("arcore_c_api.h")
        .header_contents(
            "metadata.h",
            r#"
            #include <camera/NdkCameraMetadata.h>
            static const uint32_t ANDROID_SENSOR_TIMESTAMP_TAG = ACAMERA_SENSOR_TIMESTAMP;
            static const uint8_t ANDROID_METADATA_INT64 = ACAMERA_TYPE_INT64;
        "#,
        )
        .allowlist_function("Ar.*")
        .allowlist_type("Ar.*")
        .allowlist_var("AR_.*|ANDROID_SENSOR_TIMESTAMP_TAG|ANDROID_METADATA_INT64")
        .clang_arg("--target=aarch64-linux-android32")
        .clang_arg(format!("--sysroot={}/sysroot", llvm.display()))
        .clang_arg(format!("-resource-dir={}/lib/clang/21", llvm.display()))
        .detect_include_paths(false)
        .use_core()
        .generate_comments(false)
        .formatter(bindgen::Formatter::Prettyplease)
        .rust_target(bindgen::RustTarget::stable(85, 0).unwrap())
        .rust_edition(bindgen::RustEdition::Edition2024)
        .raw_line("// Google ARCore SDK 1.57.0, Copyright 2017 Google LLC.")
        .raw_line("// https://developers.google.com/ar/develop/terms")
        .generate()
        .expect("generate bindings")
        .write_to_file("bindings.rs")
        .expect("write bindings");
}
