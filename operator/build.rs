use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../protocol/wire.fbs");
    println!("cargo:rerun-if-env-changed=FLATC");
    let compiler = env::var_os("FLATC").unwrap_or_else(|| "flatc".into());
    let version = Command::new(&compiler)
        .arg("--version")
        .output()
        .expect("Install flatc 25.9.23 or set FLATC to its path; see protocol/README.md");
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        "flatc version 25.9.23"
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    assert!(
        Command::new(compiler)
            .args(["--rust", "-o"])
            .arg(output)
            .arg("../protocol/wire.fbs")
            .status()
            .unwrap()
            .success()
    );
}
