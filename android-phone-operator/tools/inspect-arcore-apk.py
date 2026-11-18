#!/usr/bin/env python3
"""Inspect the separate ARCore artifact; never installs or launches it."""
import hashlib
import io
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
out = root / 'build/arcore'
apk = out / 'phone-operator-arcore-debug.apk'
def run(*args):
    return subprocess.check_output([str(a) for a in args], text=True)

signature = run(bt/'apksigner', 'verify', '--verbose', '--print-certs', apk)
assert 'Verified using v3 scheme (APK Signature Scheme v3): true' in signature
run(bt/'zipalign', '-c', '-P', '16', '4', apk)
manifest = run(bt/'aapt', 'dump', 'xmltree', apk, 'AndroidManifest.xml')
assert 'package="dev.xroperator.phone.arcore.experimental"' in manifest
assert 'android:minSdkVersion' in manifest and '0x20' in manifest
assert 'android:targetSdkVersion' in manifest and '0x24' in manifest
assert 'dev.xroperator.phone.MainActivity' in manifest
assert 'com.google.ar.core.InstallActivity' in manifest and 'com.google.ar.core.min_apk_version' in manifest
assert hex(262070000) in manifest
for query in ['com.google.ar.core','com.android.vending','com.google.android.play.core.install.BIND_INSTALL_SERVICE']:
    assert query in manifest
assert 'android.intent.action.MAIN' in manifest and 'android.intent.category.LAUNCHER' in manifest
assert 'Phone Operator (ARCore)' in manifest
assert manifest.count('E: uses-permission') == 2
assert 'android.permission.INTERNET' in manifest and 'android.permission.CAMERA' in manifest
assert 'android.hardware.camera.ar' in manifest
assert 'android.permission.ACCESS_FINE_LOCATION' not in manifest
expected = {'libphone_operator.so','libarcore_sdk_c.so','libarcore_sdk_jni.so'}
libraries = []
with zipfile.ZipFile(apk) as z, zipfile.ZipFile(root/'build/arcore-sdk/core-1.57.0.aar') as aar:
    names = [n for n in z.namelist() if n.endswith('.so')]
    assert {Path(n).name for n in names} == expected and len(names) == 3
    for name in names:
        assert name.startswith('lib/arm64-v8a/')
        local = out/'apk'/name
        content = z.read(name)
        assert content == local.read_bytes()
        if Path(name).name.startswith('libarcore'):
            assert content == aar.read(name.replace('lib/','jni/',1))
        else:
            assert content == (root/'target/arcore/aarch64-linux-android/release/libphone_operator.so').read_bytes()
        elf = run(llvm/'llvm-readelf', '-h', '-l', '-d', local)
        assert 'AArch64' in elf
        loads = [line for line in elf.splitlines() if line.strip().startswith('LOAD')]
        alignments = [int(line.split()[-1], 16) for line in loads]
        assert alignments and min(alignments) >= 16384
        needed = re.findall(r'\(NEEDED\).*?\[([^]]+)\]', elf)
        assert set(needed) <= {'libc.so','libdl.so','libm.so','liblog.so','libEGL.so','libGLESv2.so','libandroid.so','libarcore_sdk_c.so'}
        libraries.append({'name':name,'sha256':hashlib.sha256(content).hexdigest(),'load_alignments':alignments,'needed':needed})
    assert z.read('classes.dex').startswith(b'dex\n') and 'resources.arsc' in z.namelist()
exports = run(llvm/'llvm-nm','-D','--defined-only',out/'apk/lib/arm64-v8a/libphone_operator.so')
java = run('javap','-s','-p','-classpath',out/'classes','dev.xroperator.phone.MainActivity')
methods = re.findall(r'native [\w.]+ (native\w+)\(',java)
assert len(methods) == 10, methods
for method in methods:
    assert 'Java_dev_xroperator_phone_MainActivity_' + method in exports
dex = run(bt/'dexdump','-d',out/'dex/classes.dex')
defined_classes = set(re.findall(r"Class descriptor\s*:\s*'([^']+)'",dex))
for name in ['Lcom/google/ar/core/InstallActivity;','Lcom/google/ar/core/ArCoreApk;','Lcom/google/ar/core/R$string;','Ldev/xroperator/phone/MainActivity;']:
    assert name in defined_classes, name
with zipfile.ZipFile(root/'build/arcore-sdk/core-1.57.0.aar') as aar:
    with zipfile.ZipFile(io.BytesIO(aar.read('classes.jar'))) as jar:
        sdk_classes = {'L'+n[:-6]+';' for n in jar.namelist() if n.endswith('.class')}
with zipfile.ZipFile(root/'build/arcore-sdk/annotation-1.3.0.jar') as jar:
    annotation_classes = {'L'+n[:-6]+';' for n in jar.namelist() if n.endswith('.class')}
assert sdk_classes <= defined_classes, sdk_classes-defined_classes
assert annotation_classes <= defined_classes, annotation_classes-defined_classes
resources = run(bt/'aapt','dump','resources',apk)
for line in (root/'build/arcore-sdk/aar/R.txt').read_text().splitlines():
    _,kind,name,_ = line.split()
    assert ':'+kind+'/'+name in resources, name
print(json.dumps({'apk':str(apk),'sha256':hashlib.sha256(apk.read_bytes()).hexdigest(),
    'package':'dev.xroperator.phone.arcore.experimental','activity':'dev.xroperator.phone.MainActivity',
    'port':8081,'min_sdk':32,'target_sdk':36,'sdk':'com.google.ar:core:1.57.0','abi':'arm64-v8a',
    'jni_methods':methods,'libraries':libraries,'signature':signature.strip().splitlines(),
    'complete_sdk_classes':len(sdk_classes),'complete_annotation_classes':len(annotation_classes),
    'sdk_resources':'All declared AAR resources present; generated com.google.ar.core.R classes in DEX',
    'device_install_or_launch_tested':False,'bytes':apk.stat().st_size},indent=2))
