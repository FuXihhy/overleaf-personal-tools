# Optional local TeX backend

The extension defaults to MathJax. The optional **TeX → 本机 TeX** choice sends the generated preview document to the dedicated Chrome native host `com.overleaf.personal_tools`. The host returns a PDF through Chrome's native-messaging pipe. It starts no HTTP server and accepts no URL, shell command, executable path, or file path outside that document. Cloud and local TeX results use the same browser-only PDF.js rasterizer.

The native host is currently a macOS implementation for a system TeX Live/MacTeX installation under `/usr/local/texlive`, discovered through `/Library/TeX/texbin`. It uses the existing `/usr/bin/python3` and Python standard library. It does not install TeX, packages, Python libraries, or a background service. Missing packages produce the compiler's diagnostic. User-level `~/texmf` packages and user fonts are intentionally outside the sandbox; copy needed source into the Overleaf project or install the package in the system TeX tree.

## Installation

From the repository directory, first inspect the generated registration plan:

```sh
/usr/bin/python3 native/install.py
```

This default operation is read-only. To register the prepared host for the current user's Google Chrome:

```sh
/usr/bin/python3 native/install.py --install
```

The installer derives the stable extension ID from `manifest.json`'s public `key`: SHA-256, first 16 digest bytes, hexadecimal digits mapped to `a`–`p`. The registration allows exactly that one `chrome-extension://…/` origin. It copies the host and a launcher using a fixed Python path into `~/Library/Application Support/OverleafPersonalTools/native-host/`, and writes only its dedicated manifest under Chrome's `NativeMessagingHosts` directory. Re-run `--install` after updating the native Python code. The browser extension itself is still loaded separately from `dist/`.

```sh
/usr/bin/python3 native/install.py --uninstall
```

Uninstallation removes only the dedicated manifest and the directory carrying this installer's ownership marker. It refuses to delete an unmarked directory, a conflicting registration, or a symlink at either destination. It leaves TeX Live, the extension, and all project files intact. Chrome Beta, Chromium, Edge, and other browsers are not registered by this installer.

## Security boundary and limits

TeX source can execute more than mathematical notation. The host therefore always invokes `/usr/bin/sandbox-exec` with a `deny default` profile. If the sandbox is missing or cannot launch, compilation fails; there is no unsandboxed fallback. The status request performs a real sandboxed compiler startup probe, rather than reporting presence of a binary as sufficient.

The child may read its temporary job, the detected system TeX tree, system libraries/locales, and system fonts. It may write only within that job and `/dev/null`. Network and other Mach services remain denied. The profile never allows the user's home directory. A literal read of `/` is required by current macOS process startup; this does not allow reads of files below it. Only the chosen TeX binary, its `xdvipdfmx` converter, and the system shell needed for XeTeX's converter pipe can execute. These child processes inherit the same sandbox.

Every compiler receives `-no-shell-escape`, `-no-parse-first-line`, `openin_any=p`, and `openout_any=p`. Automatic format/font generation is disabled. LuaLaTeX also receives `--safer --nosocket`. A fresh environment directs `HOME`, temporary files, and user TeX/config/cache locations into the job. No browser-controlled environment variable or command-line option is accepted.

Sources must be project-relative, non-hidden text files, with no `.` or `..` segments, backslashes, or path collisions. Configuration entry points such as `texmf.cnf`, `latexmkrc`, `dvipdfmx.cfg`, and internal output/cache names are rejected. Limits are 256 files, 2 MiB per file, 8 MiB total source, a 10 MiB input message, 14 seconds wall time, 10 seconds CPU soft limit (12 seconds hard), 4 MiB per output file, and 64 open descriptors. The process limit uses the user's current process count plus eight because macOS `RLIMIT_NPROC` counts all of that user's processes, not only this job. Only the known `opt-preview.pdf` output is returned, up to 650 KiB; the JSON response remains below Chrome's 1 MiB host-message limit.

A host handles one render at a time. A newer request cancels the active task and replaces any queued task. Disconnecting the native port closes stdin, which cancels the compiler. Cancellation and timeout kill the entire process group, including converter children, and the temporary directory is removed afterward. The host checks the job directory every 250 ms and after compilation, rejecting more than 32 MiB or 1,024 files; these sampled directory limits complement the kernel's per-file limit. Diagnostics go into the response; protocol-independent logging goes to stderr, never stdout.

`sandbox-exec` is a macOS-specific, legacy interface. A future macOS update may change or remove it. The intended behavior is to report local TeX unavailable and retain the MathJax/cloud alternatives. This is a deliberately small local preview host, not a general service for compiling arbitrary untrusted projects. Resource limits are defense in depth, not a proof against every TeX-engine or operating-system vulnerability.

## Protocol and verification

Input and output use a four-byte little-endian UTF-8 JSON byte count followed by JSON, as required by Chrome native messaging. Status requests are `{op:"status",version:1,id}` and echo the ID with `{available,version,compilers,sandbox,message}`. Render requests and responses follow `src/preview/tex-types.ts`; a failed render has diagnostics and no `pdfBase64`. Error messages are capped at 3,500 characters. Successful results also include up to 12 compiler warnings of at most 500 characters each, including undefined references and missing glyphs, so a PDF containing `??` is not silently treated as warning-free. The extension must keep the native port open until a response or explicitly disconnect to cancel.

Run the tests without installing the host:

```sh
/usr/bin/python3 -m unittest discover -s native/tests -v
```

The tests use only synthetic source and a temporary sentinel they create themselves. They cover native framing, source limits and path traversal/config rejection, exact registration origin and confined uninstall, missing-sandbox failure, all installed compilers with `physics` and `xparse`, disabled shell escape, denied external sentinel reads and writes (including a Lua read bypassing TeX's own path policy), timeout, cancellation, and native-port disconnect. Real engine tests are skipped on machines without macOS sandbox-exec/system TeX Live. They do not read user documents or install a native host.
