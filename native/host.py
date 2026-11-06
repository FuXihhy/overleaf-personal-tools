#!/usr/bin/python3
"""Sandboxed, single-job Chrome native-messaging TeX compiler (Python 3.9+)."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import platform
import queue
import re
if os.name != 'nt':
    import resource
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import threading
import time

VERSION = "0.2.1"
MAX_MESSAGE = 10 * 1024 * 1024
MAX_FILE = 2 * 1024 * 1024
MAX_SOURCE = 8 * 1024 * 1024
MAX_PDF = 650 * 1024
MAX_JOB_BYTES = 32 * 1024 * 1024
MAX_JOB_FILES = 1024
TIMEOUT = 14
# Each Windows LuaLaTeX job has a fresh private font cache. Font discovery can
# spend more wall time in filesystem/antimalware I/O than the POSIX baseline.
# This stays below the browser's 32-second transport timeout; the Job Object
# still enforces the same 12-second CPU budget, and cancellation is immediate.
WINDOWS_LUA_TIMEOUT = 24
COMPILERS = ("pdflatex", "xelatex", "lualatex")
SANDBOX = Path("/usr/bin/sandbox-exec")
FORBIDDEN_NAMES = {"texmf.cnf", "texmfvars.cnf", "texmfconfig", "ls-r", ".latexmkrc", "latexmkrc", "fmtutil.cnf", "updmap.cfg", "dvipdfmx.cfg", "pdftex.cfg", "luatex.lua", "luaotfload.conf", "texmf.lua", "mktex.cnf"}


class HostError(Exception):
    pass


def compiler_paths():
    result = {}
    if os.name == 'nt':
        # This is the host's installed environment, never browser input. Admit
        # only real executables in an identifiable Windows TeX Live tree.
        for name in COMPILERS:
            candidate = shutil.which(name + '.exe')
            if candidate:
                path = Path(candidate).resolve()
                try:
                    root = tex_root(path)
                    if path.parent == root / 'bin' / 'windows':
                        result[name] = path
                except HostError:
                    pass
        return result
    # Fixed installation locations. Never use a browser-supplied executable/PATH.
    for directory in (Path("/Library/TeX/texbin"), Path("/usr/local/texlive/2026/bin/universal-darwin")):
        for name in COMPILERS:
            path = directory / name
            if name not in result and path.is_file() and os.access(str(path), os.X_OK):
                resolved = path.resolve()
                # Only a system TeX Live tree is admitted by this backend.
                if str(resolved).startswith("/usr/local/texlive/"):
                    result[name] = resolved
    return result


def tex_root(executable):
    for parent in executable.parents:
        if (parent / "texmf-dist" / "web2c").is_dir():
            return parent
    raise HostError("无法识别系统 TeX Live 安装目录。")


def quote_sb(value):
    return json.dumps(str(value), ensure_ascii=True)


def sandbox_profile(job, executable):
    job = Path(job).resolve()
    root = tex_root(executable)
    converter = executable.parent / "xdvipdfmx"
    readable = [job, root, Path("/usr/local/texlive/texmf-local"), Path("/Library/TeX"), Path("/Library/Fonts"), Path("/System"), Path("/usr/lib"), Path("/usr/share/locale")]
    # libSystem opens the root directory during process startup on current macOS.
    # The literal permits that directory itself, not its descendants.
    literals = ["/", "/dev/null", "/dev/random", "/dev/urandom", "/bin/sh", "/bin/bash", "/private/var/select/sh"]
    return "\n".join([
        "(version 1)", "(deny default)",
        "(allow process-fork)",
        "(allow process-exec %s)" % " ".join("(literal %s)" % quote_sb(p) for p in [executable, converter, "/bin/sh", "/bin/bash"]),
        "(allow signal (target same-sandbox))", "(allow sysctl-read)",
        "(allow file-read* %s %s)" % (" ".join("(subpath %s)" % quote_sb(p) for p in readable), " ".join("(literal %s)" % quote_sb(p) for p in literals)),
        "(allow file-read-metadata %s)" % " ".join("(literal %s)" % quote_sb(p) for p in ["/", "/usr", "/usr/local", "/usr/local/texlive", "/private", "/private/tmp", "/Library", "/dev"]),
        "(allow file-write* (subpath %s) (literal \"/dev/null\"))" % quote_sb(job),
    ])


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 512 or any(ch in value for ch in "\\\0\r\n"):
        raise HostError("源文件路径无效。")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in (".", "..", "") for part in value.split("/")) or ":" in value:
        raise HostError("源文件路径必须位于项目内。")
    if os.name == 'nt' and any(part.endswith((' ', '.')) or re.fullmatch(r'(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part, re.I) for part in path.parts):
        raise HostError("拒绝 Windows 设备名称及不明确的文件路径。")
    if any(part.startswith(".") or part.lower() in FORBIDDEN_NAMES for part in path.parts):
        raise HostError("拒绝隐藏文件或 TeX 配置文件路径。")
    if path.parts[0].lower() in {"tex-home", "tex-var", "tex-config", "tex-cache"} or path.name.lower().startswith("opt-preview.") or path.name.lower() == "compiler-output.txt":
        raise HostError("源文件路径与预览内部文件冲突。")
    if path.suffix.lower() not in (".tex", ".sty", ".cls", ".ltx", ".def", ".cfg", ".clo", ".tikz", ".bib", ".txt"):
        raise HostError("本地预览只接受文本源文件。")
    # `.cfg` package source is useful, but executable/config entry points are not.
    if path.name.lower() in FORBIDDEN_NAMES:
        raise HostError("拒绝 TeX 系统配置文件。")
    return path.as_posix()


def validate_document(value):
    if not isinstance(value, dict) or not isinstance(value.get("files"), list) or len(value["files"]) > 256:
        raise HostError("TeX 文档文件列表无效。")
    entry = safe_path(value.get("entryPath"))
    if not entry.endswith(".tex"):
        raise HostError("预览入口必须是 .tex 文件。")
    files, total = {}, 0
    for item in value["files"]:
        if not isinstance(item, dict) or not isinstance(item.get("content"), str):
            raise HostError("源文件内容无效。")
        path = safe_path(item.get("path"))
        collision = path.casefold()
        if any(existing.casefold() == collision for existing in files):
            raise HostError("源文件路径重复。")
        data = item["content"].encode("utf-8")
        if b"\0" in data or len(data) > MAX_FILE:
            raise HostError("源文件不是文本或超过 2 MiB。")
        total += len(data)
        if total > MAX_SOURCE:
            raise HostError("源文件总大小超过 8 MiB。")
        files[path] = data
    if entry not in files:
        raise HostError("预览入口不在文件列表中。")
    return entry, files


def clean_environment(job, executable):
    root = tex_root(executable)
    result = {
        "PATH": str(executable.parent) + ("" if os.name == 'nt' else ":/usr/bin:/bin"),
        "HOME": str(job), "TMPDIR": str(job), "TMP": str(job), "TEMP": str(job),
        "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8",
        "TEXMFCNF": str(root / "texmf-dist" / "web2c"),
        "TEXMFHOME": str(job / "tex-home"), "TEXMFVAR": str(job / "tex-var"),
        "TEXMFCONFIG": str(job / "tex-config"), "TEXMFCACHE": str(job / "tex-cache"),
        "TEXMFOUTPUT": str(job), "openin_any": "p", "openout_any": "p",
        "shell_escape": "f", "MKTEXFMT": "0", "MKTEXTFM": "0", "MKTEXPK": "0",
    }
    if os.name == 'nt':
        # Needed by Windows loader/XeTeX; no user environment is forwarded.
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        if not ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer)):
            raise HostError('无法确定 Windows 系统目录。')
        result.update(SystemRoot=buffer.value, WINDIR=buffer.value,
                      USERPROFILE=str(job), LOCALAPPDATA=str(job), APPDATA=str(job),
                      COMSPEC=str(Path(buffer.value) / 'System32' / 'cmd.exe'))
        result['PATH'] += ';' + str(Path(buffer.value) / 'System32')
        if executable.name.lower() == 'lualatex.exe':
            # luaotfload opens kpse-resolved absolute Unicode-data paths through
            # Lua I/O; TeX Live 2024 rejects these with openin_any=p. Retain
            # dotfile restrictions while AppContainer enforces the actual
            # read allowlist, including Lua I/O (integration-tested).
            result['openin_any'] = 'r'
    return result


def process_limit():
    # RLIMIT_NPROC counts the user's existing processes, not just this job.
    # Admit a small margin for XeTeX's PDF converter, rather than using a fixed
    # limit that would prevent all forking on a busy desktop.
    try:
        result = subprocess.run(["/bin/ps", "-u", str(os.getuid()), "-o", "pid="], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2, check=True)
        return len(result.stdout.splitlines()) + 8
    except (OSError, subprocess.SubprocessError):
        raise HostError("无法建立 TeX 子进程数量限制。")


def apply_limits(max_processes):
    resource.setrlimit(resource.RLIMIT_CPU, (10, 12))
    resource.setrlimit(resource.RLIMIT_FSIZE, (4 * 1024 * 1024, 4 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if hasattr(resource, "RLIMIT_NPROC"):
        _, hard = resource.getrlimit(resource.RLIMIT_NPROC)
        limit = max_processes if hard == resource.RLIM_INFINITY else min(hard, max_processes)
        resource.setrlimit(resource.RLIMIT_NPROC, (limit, limit))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def terminate_group(process):
    if os.name == 'nt':
        process.close()
        return
    # Also kill surviving converter children if the TeX leader has exited.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def check_job_budget(job):
    total, count = 0, 0
    for directory, directories, files in os.walk(str(job), followlinks=False):
        count += len(directories)
        for name in directories:
            info = os.lstat(os.path.join(directory, name))
            if getattr(info, 'st_file_attributes', 0) & 0x400:
                raise HostError('TeX 临时目录出现重解析点。')
        if count > MAX_JOB_FILES:
            raise HostError("TeX 临时文件数量超过限制。")
        for name in files:
            count += 1
            if count > MAX_JOB_FILES:
                raise HostError("TeX 临时文件数量超过限制。")
            try:
                info = os.lstat(os.path.join(directory, name))
                if getattr(info, 'st_file_attributes', 0) & 0x400:
                    raise HostError('TeX 临时目录出现重解析点。')
                if info.st_size > 4 * 1024 * 1024:
                    raise HostError('TeX 临时文件超过 4 MiB 限制。')
                total += info.st_size
            except FileNotFoundError:
                continue
            if total > MAX_JOB_BYTES:
                raise HostError("TeX 临时目录超过 32 MiB 限制。")


def compile_warnings(job):
    warnings = []
    # Keep parsing bounded even if a package floods the transcript.
    transcript = job / "opt-preview.log"
    if not transcript.is_file() or transcript.is_symlink():
        transcript = job / "compiler-output.txt"
    with transcript.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        stream.seek(max(0, stream.tell() - 64 * 1024))
        lines = stream.read(64 * 1024).decode("utf-8", "replace").replace(str(job), "[preview]").splitlines()
    marker = re.compile(r"^(?:(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning:|pdfTeX warning|Missing character:|Overfull \\[hv]box)")
    for index, line in enumerate(lines):
        if not marker.match(line):
            continue
        parts = [line.strip()]
        for following in lines[index + 1:index + 4]:
            if not following.strip() or marker.match(following) or following.startswith("[") or following.startswith(" "):
                break
            # Package warnings wrap with '(package)' or unindented prose.
            if following.startswith("(") and not re.match(r"^\([\w-]+\)\s", following):
                break
            parts.append(following.strip())
        text = " ".join(parts)[:500]
        if text not in warnings:
            warnings.append(text)
        if len(warnings) >= 12:
            break
    return warnings


def render(request, cancelled=None):
    started = time.monotonic()
    identifier = request.get("id")
    if not isinstance(identifier, str) or len(identifier) > 128:
        raise HostError("请求 ID 无效。")
    if request.get("version") != 1 or request.get("op") != "render":
        raise HostError("不支持的协议版本或操作。")
    windows = os.name == 'nt'
    if not windows and (platform.system() != "Darwin" or not SANDBOX.is_file()):
        raise HostError("本地预览需要 macOS sandbox-exec；不会降级为无沙盒运行。")
    compiler = request.get("compiler")
    executable = compiler_paths().get(compiler)
    if executable is None:
        raise HostError("所选 TeX 编译器未安装。")
    if windows:
        try:
            from windows_tex import SandboxedProcess, configured
            if not configured(tex_root(executable)):
                raise HostError('Windows TeX AppContainer 尚未配置；请重新运行本机 TeX 安装器。不会降级为无沙盒运行。')
        except ImportError as error:
            raise HostError('Windows TeX 需要 pywin32 和 AppContainer 支持；不会降级为无沙盒运行。') from error
    entry, files = validate_document(request.get("document"))
    if cancelled is not None and cancelled.is_set():
        raise HostError("预览已取消。")

    with tempfile.TemporaryDirectory(prefix="overleaf-personal-", dir=None if windows else "/private/tmp") as directory:
        job = Path(directory).resolve()
        for path, data in files.items():
            target = job / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for name in ("tex-home", "tex-var", "tex-config", "tex-cache"):
            (job / name).mkdir(exist_ok=True)
        output = job / "opt-preview.pdf"
        if output.exists():
            raise HostError("预览输出路径与源文件冲突。")
        arguments = ([] if windows else [str(SANDBOX), "-p", sandbox_profile(job, executable)]) + [str(executable),
                     "-fmt=" + compiler, "-progname=" + compiler, "-no-parse-first-line", "-no-shell-escape", "-no-mktex=fmt", "-no-mktex=tfm", "-no-mktex=pk",
                     "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-recorder", "-jobname=opt-preview", "-output-directory=" + str(job)]
        if compiler == "lualatex":
            if windows:
                # LuaHBTeX 1.18 rejects this pdfTeX/XeTeX option. The explicit
                # fmt/progname remain fixed. --safer disables luaotfload itself;
                # Windows enforces file/process/network confinement at the OS
                # AppContainer boundary (tested using raw Win32 and Lua I/O).
                arguments.remove('-no-parse-first-line')
                arguments.append('--nosocket')
            else:
                arguments.extend(["--safer", "--nosocket"])
        arguments.append("./" + entry)
        process = None
        max_processes = None if windows else process_limit()
        try:
            with (job / "compiler-output.txt").open("wb") as log:
                if windows:
                    process = SandboxedProcess(arguments, job, clean_environment(job, executable), log)
                else:
                    process = subprocess.Popen(arguments, cwd=str(job), env=clean_environment(job, executable), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                               start_new_session=True, preexec_fn=lambda: apply_limits(max_processes))
                timeout = WINDOWS_LUA_TIMEOUT if windows and compiler == 'lualatex' else TIMEOUT
                deadline = time.monotonic() + timeout
                next_budget_check = time.monotonic() + 0.25
                while process.poll() is None:
                    if cancelled is not None and cancelled.wait(0.05):
                        terminate_group(process)
                        raise HostError("预览已取消。")
                    if cancelled is None:
                        time.sleep(0.05)
                    if time.monotonic() > deadline:
                        terminate_group(process)
                        raise HostError("本地 TeX 编译超过 %g 秒，已终止。" % timeout)
                    if time.monotonic() >= next_budget_check:
                        check_job_budget(job)
                        next_budget_check = time.monotonic() + 0.25
            check_job_budget(job)
            if process.returncode != 0 or not output.is_file():
                with (job / "compiler-output.txt").open("rb") as log:
                    log.seek(0, os.SEEK_END); end = log.tell(); log.seek(max(0, end - 3000))
                    detail = log.read().decode("utf-8", "replace").replace(str(job), "[preview]")
                raise HostError("TeX 编译失败（退出码 %s）：\n%s" % (process.returncode, detail))
            if output.is_symlink() or output.stat().st_size > MAX_PDF:
                raise HostError("生成的预览 PDF 超过约 650 KiB 限额。")
            data = output.read_bytes()
            if not data.startswith(b"%PDF-"):
                raise HostError("编译结果不是 PDF。")
            diagnostics = request["document"].get("diagnostics", [])
            diagnostics = [str(item)[:300] for item in diagnostics[:20]] if isinstance(diagnostics, list) else []
            diagnostics.extend(item for item in compile_warnings(job) if item not in diagnostics)
            return {"id": identifier, "pdfBase64": base64.b64encode(data).decode("ascii"), "diagnostics": diagnostics,
                    "elapsedMs": int((time.monotonic() - started) * 1000)}
        finally:
            if process is not None:
                terminate_group(process)


def status():
    compilers = sorted(compiler_paths())
    if os.name == 'nt':
        message = 'Windows TeX AppContainer 尚未配置；不会降级为无沙盒运行。'
        available = False
        try:
            from windows_tex import configured
            if compilers:
                probe_compiler = next(name for name in COMPILERS if name in compilers)
                executable = compiler_paths()[probe_compiler]
                if configured(tex_root(executable)):
                    # A version banner does not prove kpathsea can open the TeX
                    # tree. Compile a disposable formula before claiming ready.
                    probe = render({'id': 'sandbox-status-probe', 'version': 1, 'op': 'render',
                        'compiler': probe_compiler, 'document': {'entryPath': 'main.tex',
                        'files': [{'path': 'main.tex', 'content': r'\documentclass{article}\begin{document}\(x+1\)\end{document}'}]}})
                    available = bool(probe.get('pdfBase64'))
                    message = 'Windows AppContainer + Job Object 沙盒可用。' if available else 'Windows 沙盒启动检测失败；不会降级为无沙盒运行。'
        except Exception as error:
            message = 'Windows 沙盒启动检测失败；不会降级为无沙盒运行：' + str(error)[:500]
        return {'available': available, 'version': VERSION, 'compilers': compilers, 'sandbox': available, 'message': message}
    sandbox = platform.system() == "Darwin" and SANDBOX.is_file()
    message = "未发现可用的 macOS 沙盒或系统 TeX Live 编译器。"
    if sandbox and compilers:
        try:
            with tempfile.TemporaryDirectory(prefix="overleaf-personal-probe-", dir="/private/tmp") as directory:
                job = Path(directory).resolve()
                executable = compiler_paths()[compilers[0]]
                max_processes = process_limit()
                probe = subprocess.run([str(SANDBOX), "-p", sandbox_profile(job, executable), str(executable), "--version"], cwd=str(job), env=clean_environment(job, executable), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, preexec_fn=lambda: apply_limits(max_processes))
                sandbox = probe.returncode == 0
                message = "本机 TeX 沙盒可用。" if sandbox else "沙盒启动检测失败；本地预览不会在无沙盒环境运行。"
        except (OSError, subprocess.SubprocessError, HostError):
            sandbox = False
            message = "沙盒启动检测失败；本地预览不会在无沙盒环境运行。"
    return {"available": sandbox and bool(compilers), "version": VERSION, "compilers": compilers, "sandbox": sandbox, "message": message}


def read_message(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise HostError("Native 消息长度头不完整。")
    length = struct.unpack("<I", header)[0]
    if not length or length > MAX_MESSAGE:
        raise HostError("Native 消息超过大小限制。")
    body = stream.read(length)
    if len(body) != length:
        raise HostError("Native 消息内容不完整。")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise HostError("Native 消息必须是对象。")
    return value


def write_message(stream, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(data) >= 1024 * 1024:
        data = json.dumps({"id": value.get("id"), "diagnostics": ["Native 结果超过 1 MiB 限制。"]}).encode("utf-8")
    stream.write(struct.pack("<I", len(data))); stream.write(data); stream.flush()


def main():
    if os.name == 'nt':
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    inbox = queue.Queue(maxsize=1)
    stopped = threading.Event()
    lock = threading.Lock()
    active = [None]

    def receive():
        try:
            while not stopped.is_set():
                message = read_message(sys.stdin.buffer)
                if message is None:
                    break
                # Latest request wins. Cancel the active job before queueing.
                with lock:
                    if active[0] is not None:
                        active[0].set()
                    try:
                        _, previous = inbox.get_nowait()
                        previous.set()
                    except queue.Empty:
                        pass
                    cancel = threading.Event()
                    inbox.put((message, cancel))
        except Exception as error:
            print("native input: " + str(error), file=sys.stderr)
        finally:
            with lock:
                stopped.set()
                if active[0] is not None:
                    active[0].set()

    threading.Thread(target=receive, daemon=True).start()
    while not stopped.is_set() or not inbox.empty():
        try: request, cancel = inbox.get(timeout=0.1)
        except queue.Empty: continue
        with lock:
            active[0] = cancel
            # A replacement may have arrived between get() and the lock.
            if stopped.is_set() or not inbox.empty():
                cancel.set()
        try:
            if not isinstance(request.get("id"), str) or len(request["id"]) > 128 or request.get("version") != 1:
                raise HostError("Native 请求 ID 或协议版本无效。")
            if request.get("op") == "status":
                result = dict(status(), id=request.get("id"))
            else:
                result = render(request, cancel)
        except Exception as error:
            result = {"id": request.get("id"), "diagnostics": [str(error)[:3500]]}
        try: write_message(sys.stdout.buffer, result)
        except (BrokenPipeError, OSError): break


if __name__ == "__main__":
    main()
