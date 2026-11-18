#!/usr/bin/env python3
"""Validate the independently packaged debug APK, manifest, JNI names and ABI."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
sdk = Path(os.environ.get('ANDROID_SDK_ROOT', Path.home() / 'Android/Sdk'))
bt = sdk / 'build-tools' / os.environ.get('ANDROID_BUILD_TOOLS', '36.1.0')
ndk = Path(os.environ.get('ANDROID_NDK_HOME', sdk / 'ndk/29.0.14206865'))
llvm = ndk / 'toolchains/llvm/prebuilt/linux-x86_64/bin'
apk = root / 'build/phone-operator-debug.apk'
lib = root / 'target/aarch64-linux-android/release/libphone_operator.so'
def run(*args):
    return subprocess.check_output([str(a) for a in args], text=True)

signature = run(bt/'apksigner', 'verify', '--verbose', apk)
assert 'Verified using v3 scheme (APK Signature Scheme v3): true' in signature
run(bt/'zipalign', '-c', '-P', '16', '4', apk)
manifest = run(bt/'aapt', 'dump', 'xmltree', apk, 'AndroidManifest.xml')
assert 'package="dev.xroperator.phone.experimental"' in manifest
assert 'android:minSdkVersion' in manifest and '0x20' in manifest
assert 'android:targetSdkVersion' in manifest and '0x24' in manifest
assert 'dev.xroperator.phone.MainActivity' in manifest
assert 'android.intent.action.MAIN' in manifest and 'android.intent.category.LAUNCHER' in manifest
assert 'Phone Operator (IMU)' in manifest
assert manifest.count('E: uses-permission') == 1 and 'android.permission.INTERNET' in manifest
with zipfile.ZipFile(apk) as z:
    assert [n for n in z.namelist() if n.endswith('.so')] == ['lib/arm64-v8a/libphone_operator.so']
    assert z.read('lib/arm64-v8a/libphone_operator.so') == lib.read_bytes()
    assert z.read('classes.dex').startswith(b'dex\n')
exports = run(llvm/'llvm-nm', '-D', '--defined-only', lib)
java = run('javap', '-s', '-p', '-classpath', root/'build/classes', 'dev.xroperator.phone.MainActivity')
methods = re.findall(r'native [\w.]+ (native\w+)\(', java)
assert len(methods) == 6, methods
for method in methods:
    assert 'Java_dev_xroperator_phone_MainActivity_' + method in exports, method
elf = run(llvm/'llvm-readelf', '-h', '-l', '-d', lib)
assert 'AArch64' in elf
loads = [line for line in elf.splitlines() if line.strip().startswith('LOAD')]
assert loads and all(line.strip().endswith('0x4000') for line in loads)
needed = re.findall(r'\(NEEDED\).*?\[([^]]+)\]', elf)
assert set(needed) <= {'libc.so','libdl.so','libm.so','liblog.so'}, needed
print(json.dumps({'apk':str(apk),'sha256':hashlib.sha256(apk.read_bytes()).hexdigest(),
 'package':'dev.xroperator.phone.experimental','activity':'dev.xroperator.phone.MainActivity',
 'min_sdk':32,'target_sdk':36,'abi':'arm64-v8a','bytes':apk.stat().st_size,
 'jni_methods':methods,'needed_platform_libraries':needed,'elf_load_alignment':16384,
 'signature':'v3 verified','position':False,'prediction':False,
 'device_install_or_launch_tested':False},indent=2))
