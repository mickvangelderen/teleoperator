use std::{env, path::PathBuf, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=../protocol/wire.fbs");
    println!("cargo:rerun-if-changed=../tools/flatc.py");
    println!("cargo:rerun-if-env-changed=FLATC");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    assert!(
        Command::new("python3")
            .args(["../tools/flatc.py", "--rust", "-o"])
            .arg(output)
            .arg("../protocol/wire.fbs")
            .status()
            .expect("Python 3 is required to prepare flatc; see protocol/README.md")
            .success(),
        "FlatBuffers generation failed; see the flatc setup error above"
    );
}
