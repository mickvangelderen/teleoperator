import hashlib
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import flatc


class CompilerSetupTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.cache = Path(temporary.name)
        self.compiler = self.cache / "Linux-x86_64/flatc"
        for replacement in (
            patch.object(flatc, "CACHE", self.cache),
            patch.dict(flatc.os.environ, {"FLATC": ""}),
            patch.object(flatc.platform, "system", return_value="Linux"),
            patch.object(flatc.platform, "machine", return_value="x86_64"),
            patch.object(flatc.shutil, "which", return_value=None),
        ):
            replacement.start()
            self.addCleanup(replacement.stop)

    def test_wrong_override_fails_without_downloading(self):
        with patch.dict(flatc.os.environ, {"FLATC": "/custom/flatc"}), patch.object(
            flatc.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "flatc version 2.0.8")
        ), patch.object(flatc.urllib.request, "urlopen") as download:
            with self.assertRaisesRegex(RuntimeError, "unset FLATC"):
                flatc.resolve_compiler()
            download.assert_not_called()

    def test_valid_override_and_system_compiler_work_offline(self):
        with patch.object(flatc.subprocess, "run", return_value=subprocess.CompletedProcess(
            [], 0, f"flatc version {flatc.VERSION}"
        )), patch.object(flatc.urllib.request, "urlopen") as download:
            with patch.dict(flatc.os.environ, {"FLATC": "/custom/flatc"}):
                self.assertEqual(flatc.resolve_compiler(), "/custom/flatc")
            with patch.object(flatc.shutil, "which", return_value="/system/flatc"):
                self.assertEqual(flatc.resolve_compiler(), "/system/flatc")
            download.assert_not_called()

    def test_wrong_system_version_downloads_once_then_uses_cache_offline(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w") as package:
            package.writestr("flatc", b"compiler fixture")
        data = archive.getvalue()

        def version(command, **kwargs):
            compiler = Path(command[0])
            if str(compiler) == "/system/flatc":
                return subprocess.CompletedProcess(command, 0, "flatc version 2.0.8")
            if not compiler.exists():
                raise FileNotFoundError(compiler)
            self.assertEqual(compiler.read_bytes(), b"compiler fixture")
            return subprocess.CompletedProcess(command, 0, f"flatc version {flatc.VERSION}")

        with patch.object(flatc.subprocess, "run", side_effect=version), patch.object(
            flatc.shutil, "which", return_value="/system/flatc"
        ), patch.dict(flatc.ASSETS, {("Linux", "x86_64"): ("fixture.zip", hashlib.sha256(data).hexdigest())}), patch.object(
            flatc.urllib.request, "urlopen", return_value=io.BytesIO(data)
        ) as download:
            self.assertEqual(flatc.resolve_compiler(), self.compiler)
            download.assert_called_once()
            download.side_effect = OSError("offline")
            self.assertEqual(flatc.resolve_compiler(), self.compiler)
            download.assert_called_once()

    def test_bad_checksum_never_installs_or_executes_download(self):
        with patch.object(flatc.subprocess, "run", side_effect=FileNotFoundError) as execute, patch.object(
            flatc.urllib.request, "urlopen", return_value=io.BytesIO(b"tampered archive")
        ):
            with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
                flatc.resolve_compiler()
            self.assertFalse(self.compiler.exists())
            execute.assert_called_once_with([str(self.compiler), "--version"], capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
