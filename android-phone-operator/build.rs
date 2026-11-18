fn main() {
    println!("cargo::rerun-if-env-changed=ARCORE_LIB_DIR");
    if let Some(dir) = std::env::var_os("ARCORE_LIB_DIR") {
        let dir = std::path::Path::new(&dir);
        println!("cargo::rustc-link-search=native={}", dir.display());
        println!(
            "cargo::rerun-if-changed={}",
            dir.join("libarcore_sdk_c.so").display()
        );
    }
}
