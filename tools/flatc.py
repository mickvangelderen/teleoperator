#!/usr/bin/env python3
"""Run the pinned host compiler, downloading an official binary when needed."""
import hashlib
import io
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

VERSION = "25.9.23"
RELEASE = f"https://github.com/google/flatbuffers/releases/download/v{VERSION}"
# SHA-256 digests published with the official release assets.
ASSETS = {
    ("Linux", "x86_64"): (
        "Linux.flatc.binary.g++-13.zip",
        "de0c6ad114a5a686ecf64322528c602c7d4512446a93f290f54f00ee5abea487",
    ),
    ("Darwin", "arm64"): (
        "Mac.flatc.binary.zip",
        "1e14d2feade6d109fa9c102e6e5ead68f325ed3da1d3022ce08d3222f828d983",
    ),
    ("Darwin", "x86_64"): (
        "MacIntel.flatc.binary.zip",
        "7a1de9cd4d0e769a39c41f3c59496bd011bc7a94d97baa58b0df8df782dc5c8d",
    ),
    ("Windows", "AMD64"): (
        "Windows.flatc.binary.zip",
        "3d6383193ecd274f5de544a6e03464a87f581befb9fc1dda9cf508fa3cce3127",
    ),
}
CACHE = Path(__file__).resolve().parents[1] / ".artifacts/tools" / f"flatc-{VERSION}"


def matches_version(compiler):
    try:
        result = subprocess.run([str(compiler), "--version"], capture_output=True, text=True)
        return result.returncode == 0 and result.stdout.strip() == f"flatc version {VERSION}"
    except OSError:
        return False


def resolve_compiler():
    override = os.environ.get("FLATC")
    if override:
        if not matches_version(override):
            raise RuntimeError(f"FLATC={override!r} must run flatc {VERSION}; unset FLATC for automatic setup")
        return override

    installed = shutil.which("flatc")
    if installed and matches_version(installed):
        return installed

    host = (platform.system(), platform.machine())
    if host not in ASSETS:
        raise RuntimeError(f"No pinned flatc binary for {'/'.join(host)}; build {VERSION} from source and set FLATC")
    cache = CACHE / "-".join(host)
    compiler = cache / ("flatc.exe" if host[0] == "Windows" else "flatc")
    if matches_version(compiler):
        return compiler

    asset, checksum = ASSETS[host]
    print(f"Downloading flatc {VERSION} for {'/'.join(host)}…", file=sys.stderr)
    url = f"{RELEASE}/{urllib.parse.quote(asset, safe='')}"
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read()
    if hashlib.sha256(archive).hexdigest() != checksum:
        raise RuntimeError("flatc archive checksum mismatch")
    cache.mkdir(parents=True, exist_ok=True)
    # Publish a complete executable atomically, including during concurrent builds.
    with tempfile.TemporaryDirectory(dir=cache) as temporary:
        staged = Path(temporary) / compiler.name
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            staged.write_bytes(package.read(compiler.name))
        staged.chmod(0o755)
        if not matches_version(staged):
            raise RuntimeError(f"Downloaded flatc {VERSION} cannot run on this host; set FLATC to a compatible build")
        staged.replace(compiler)
    return compiler


if __name__ == "__main__":
    try:
        sys.exit(subprocess.run([str(resolve_compiler()), *sys.argv[1:]]).returncode)
    except (OSError, RuntimeError, zipfile.BadZipFile, KeyError) as error:
        sys.exit(f"flatc setup failed: {error}")
