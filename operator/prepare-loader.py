#!/usr/bin/env python3
"""Install the pinned Khronos Android loader; no Android SDK or third-party Python modules needed."""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

VERSION = "1.1.65"
SHA256 = "a298c326085b09181c85235fb04d37510939bd30938ed4322c093c09780e8643"
target = Path(__file__).resolve().parent / "libs/arm64-v8a/libopenxr_loader.so"
url = f"https://repo.maven.apache.org/maven2/org/khronos/openxr/openxr_loader_for_android/{VERSION}/openxr_loader_for_android-{VERSION}.aar"
with urllib.request.urlopen(url, timeout=30) as response:
    archive = response.read()
if hashlib.sha256(archive).hexdigest() != SHA256:
    raise SystemExit("OpenXR loader archive checksum mismatch")
with zipfile.ZipFile(io.BytesIO(archive)) as package:
    library = package.read("jni/arm64-v8a/libopenxr_loader.so")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_bytes(library)
print(f"Prepared OpenXR {VERSION}: {target}")
