"""Synthetic fixtures only. Real engine tests require a working macOS TeX sandbox."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import sys
import threading
import time
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(DIRECTORY))


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


host = module("host", DIRECTORY / "host.py")
installer = module("installer", DIRECTORY / "install.py")


def request(source, compiler="pdflatex", files=None):
    return {"op": "render", "version": 1, "id": "synthetic-test", "compiler": compiler,
            "document": {"entryPath": "preview.tex", "files": [{"path": "preview.tex", "content": source}] + (files or []), "diagnostics": []}}


PLAIN = r"\documentclass{article}\pagestyle{empty}\begin{document}\(x^2+1\)\end{document}"
REAL_AVAILABLE = host.platform.system() == "Darwin" and host.SANDBOX.is_file() and bool(host.compiler_paths())


class ValidationTests(unittest.TestCase):
    def test_rejects_paths_configuration_collisions_and_limits(self):
        for path in ("../secret.tex", "/etc/secret.tex", "a/../b.tex", "a//b.tex", "a\\b.tex", "a/./b.tex", "texmf.cnf", "a/texmf.cnf", ".latexmkrc", "a/luatex.lua", "opt-preview.tex", "compiler-output.txt", "tex-cache/data.tex", "payload.pdf", "a\0.tex"):
            with self.subTest(path=path), self.assertRaises(host.HostError):
                host.safe_path(path)
        value = request(PLAIN)["document"]
        value["files"].append({"path": "Preview.tex", "content": "collision"})
        with self.assertRaises(host.HostError): host.validate_document(value)
        with self.assertRaises(host.HostError): host.validate_document(request("x" * (host.MAX_FILE + 1))["document"])
        self.assertEqual(host.safe_path("math/algebra.sty"), "math/algebra.sty")

    def test_native_framing_and_output_cap(self):
        stream = io.BytesIO()
        host.write_message(stream, {"id": "中文", "diagnostics": []})
        stream.seek(0)
        self.assertEqual(host.read_message(stream), {"id": "中文", "diagnostics": []})
        with self.assertRaises(host.HostError): host.read_message(io.BytesIO(struct.pack("<I", host.MAX_MESSAGE + 1)))
        with self.assertRaises(host.HostError): host.read_message(io.BytesIO(b"\x03\0"))
        stream = io.BytesIO()
        host.write_message(stream, {"id": "large", "pdfBase64": "a" * (1024 * 1024)})
        stream.seek(0)
        result = host.read_message(stream)
        self.assertNotIn("pdfBase64", result)
        self.assertIn("1 MiB", result["diagnostics"][0])

    def test_fail_closed_when_sandbox_missing(self):
        if os.name == 'nt':
            import windows_tex
            with patch.object(windows_tex, 'configured', return_value=False):
                self.assertFalse(host.status()['available'])
                with self.assertRaisesRegex(host.HostError, '无沙盒'):
                    host.render(request(PLAIN))
            return
        with patch.object(host, "SANDBOX", Path("/definitely-missing-sandbox")):
            self.assertFalse(host.status()["available"])
            with self.assertRaisesRegex(host.HostError, "无沙盒"):
                host.render(request(PLAIN))

    def test_environment_never_searches_user_home(self):
        executable = next(iter(host.compiler_paths().values()), Path("/usr/local/texlive/2026/bin/universal-darwin/pdftex"))
        with patch.object(host, "tex_root", return_value=Path("/usr/local/texlive/2026")):
            env = host.clean_environment(Path("/private/tmp/opt-test"), executable)
            self.assertEqual(env["openin_any"], "p")
            self.assertEqual(env["openout_any"], "p")
            self.assertNotIn(str(Path.home()), json.dumps(env))
            profile = host.sandbox_profile(Path("/private/tmp/opt-test"), executable)
            self.assertIn("(deny default)", profile)
            self.assertNotIn("allow network", profile)
            self.assertNotIn(str(Path.home()), profile)

    def test_temporary_directory_budget(self):
        with tempfile.TemporaryDirectory(prefix="opt-budget-") as directory:
            path = Path(directory)
            (path / "a.txt").write_text("1234")
            (path / "b.txt").write_text("5678")
            with patch.object(host, "MAX_JOB_BYTES", 7), self.assertRaises(host.HostError): host.check_job_budget(path)
            with patch.object(host, "MAX_JOB_FILES", 1), self.assertRaises(host.HostError): host.check_job_budget(path)


@unittest.skipUnless(REAL_AVAILABLE, "Requires macOS sandbox-exec and system TeX Live")
class RealSandboxTests(unittest.TestCase):
    def test_each_installed_compiler_and_physics_xparse(self):
        source = r"\documentclass{article}\usepackage{physics,xparse}\input{math/macros.sty}\pagestyle{empty}\begin{document}\(\ket{x}+\pdv{f}{x}+\pair{x}{y}\)\end{document}"
        extra = [{"path": "math/macros.sty", "content": r"\NewDocumentCommand{\pair}{mm}{\langle #1,#2\rangle}"}]
        for compiler in host.compiler_paths():
            with self.subTest(compiler=compiler):
                result = host.render(request(source, compiler, extra))
                self.assertEqual(result["id"], "synthetic-test")
                data = base64.b64decode(result["pdfBase64"])
                self.assertTrue(data.startswith(b"%PDF-"))
                self.assertLess(len(data), host.MAX_PDF)

    def test_no_shell_escape(self):
        source = r"\documentclass{article}\begin{document}\ifnum\pdfshellescape=0\relax\else\errmessage{Shell escape was enabled}\fi\immediate\write18{touch opt-shell-marker.txt}\IfFileExists{opt-shell-marker.txt}{\errmessage{Shell escape executed}}{}Safe\end{document}"
        self.assertIn("pdfBase64", host.render(request(source)))

    def test_successful_pdf_reports_undefined_reference(self):
        source = r"\documentclass{article}\begin{document}\(x_{\ref{missing}}\)\end{document}"
        result = host.render(request(source))
        self.assertIn("pdfBase64", result)
        self.assertTrue(any("undefined" in warning for warning in result["diagnostics"]))
        self.assertLessEqual(len(result["diagnostics"]), 12)
        self.assertTrue(all(len(warning) <= 500 for warning in result["diagnostics"]))

    def test_external_read_write_denied_with_owned_sentinel(self):
        # A private synthetic sentinel created by this test, never personal data.
        with tempfile.TemporaryDirectory(prefix="opt-sentinel-") as directory:
            sentinel = Path(directory) / "sentinel.txt"
            sentinel.write_text("SYNTHETIC_SENTINEL_DO_NOT_READ")
            source = r"\documentclass{article}\begin{document}\input{" + str(sentinel) + r"}\end{document}"
            with self.assertRaises(host.HostError): host.render(request(source))
            source = r"\documentclass{article}\newwrite\external\immediate\openout\external=" + str(sentinel) + r"\immediate\write\external{CHANGED}\begin{document}x\end{document}"
            with self.assertRaises(host.HostError): host.render(request(source))
            self.assertEqual(sentinel.read_text(), "SYNTHETIC_SENTINEL_DO_NOT_READ")
            # Lua reads bypass TeX's openin_any, so this exercises the OS sandbox.
            if "lualatex" in host.compiler_paths():
                source = r"\documentclass{article}\begin{document}\directlua{local f=io.open('" + str(sentinel) + r"','r'); if f then tex.error('External read allowed') end}Safe\end{document}"
                self.assertIn("pdfBase64", host.render(request(source, "lualatex")))

    def test_timeout_and_explicit_cancellation(self):
        infinite = r"\documentclass{article}\begin{document}\loop\iftrue\repeat\end{document}"
        started = time.monotonic()
        with patch.object(host, "TIMEOUT", 0.25), self.assertRaisesRegex(host.HostError, "终止"):
            host.render(request(infinite))
        self.assertLess(time.monotonic() - started, 3)
        cancel = threading.Event()
        timer = threading.Timer(0.2, cancel.set)
        timer.start()
        try:
            with self.assertRaisesRegex(host.HostError, "取消"):
                host.render(request(infinite), cancel)
        finally:
            timer.cancel()

    def test_native_disconnect_cancels_and_status_echoes_id(self):
        process = subprocess.Popen(["/usr/bin/python3", str(DIRECTORY / "host.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            host.write_message(process.stdin, {"op": "status", "version": 1, "id": "status-test"})
            response = host.read_message(process.stdout)
            self.assertEqual(response["id"], "status-test")
            self.assertTrue(response["available"])
            host.write_message(process.stdin, request(r"\documentclass{article}\begin{document}\loop\iftrue\repeat"))
            time.sleep(0.2)
            started = time.monotonic()
            process.stdin.close()
            process.wait(timeout=3)
            self.assertLess(time.monotonic() - started, 3)
            response = host.read_message(process.stdout)
            self.assertIn("取消", response["diagnostics"][0])
        finally:
            if process.poll() is None: process.kill(); process.wait()
            process.stdout.close(); process.stderr.close()

    def test_new_request_cancels_previous_render(self):
        process = subprocess.Popen(["/usr/bin/python3", str(DIRECTORY / "host.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            first = request(r"\documentclass{article}\begin{document}\loop\iftrue\repeat")
            first["id"] = "previous"
            host.write_message(process.stdin, first)
            time.sleep(0.2)
            second = request(PLAIN); second["id"] = "latest"
            host.write_message(process.stdin, second)
            old = host.read_message(process.stdout)
            self.assertEqual(old["id"], "previous")
            self.assertIn("取消", old["diagnostics"][0])
            latest = host.read_message(process.stdout)
            self.assertEqual(latest["id"], "latest")
            self.assertIn("pdfBase64", latest)
        finally:
            process.stdin.close()
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            process.stdout.close(); process.stderr.close()


class InstallerTests(unittest.TestCase):
    def test_stable_extension_id_and_exact_origin(self):
        manifest = json.loads((DIRECTORY.parent / "manifest.json").read_text())
        identifier = installer.extension_id(manifest)
        self.assertRegex(identifier, r"^[a-p]{32}$")
        host_manifest = installer.native_manifest(identifier, Path("/tmp/example"))
        self.assertEqual(host_manifest["allowed_origins"], ["chrome-extension://" + identifier + "/"])

    def test_install_uninstall_are_confined_to_marked_directory(self):
        with tempfile.TemporaryDirectory(prefix="opt-install-test-") as directory:
            home = Path(directory)
            outside = home / "keep-me.txt"; outside.write_text("retain")
            installation, manifest_path = installer.install("a" * 32, DIRECTORY / "host.py", home)
            self.assertTrue((installation / "host.py").is_file())
            launcher = 'launch.cmd' if os.name == 'nt' else 'launch'
            self.assertIn(installer.PYTHON, (installation / launcher).read_text())
            self.assertEqual(json.loads(manifest_path.read_text())["allowed_origins"], ["chrome-extension://" + "a" * 32 + "/"])
            installer.uninstall(home)
            self.assertFalse(installation.exists())
            self.assertFalse(manifest_path.exists())
            self.assertEqual(outside.read_text(), "retain")
            installation.mkdir(parents=True)
            with self.assertRaises(ValueError): installer.uninstall(home)


if __name__ == "__main__":
    unittest.main()
