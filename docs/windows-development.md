# Windows 开发版：安装、更新与数据

本分支基于私有仓库 v0.12.14、提交 `0803251324c32a2f213f39a4ece7ddac264ab126`。扩展显示 `0.12.15 Windows development`，固定 ID 为 `pffppbkokpnfafpechmlambifflkmbbn`，包含 LaTeX Preview 和 Codex Assistant。不要把本分支的 Windows 验证结论追溯到未修改的原始发布 ZIP；逐项证据见 [验收记录](windows-acceptance.md)。

## 安装与更新

需要 Chrome 145+、Node 22+、pnpm、Python 3.9+。Codex 需在这台 Windows 正常登录；helper 优先使用已安装桌面包的原生 exe，找不到时使用标准 npm 安装的原生 Codex exe。本机 TeX 可选，需要 TeX Live 与该 Python 中的 `pywin32`；MathJax/Overleaf 云端预览不依赖本机 TeX。不要复制另一台电脑的凭据、历史或稿件缓存。

在固定 checkout 目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm check
python -X utf8 -m unittest discover -s native/tests
python -X utf8 native/install_codex.py --install
python -X utf8 native/install.py --install
```

两个安装器分别管理 Codex/API 和 TeX host。重复执行会更新专用程序目录，保留工作目录设置和另外存储的历史/API配置。没有 `--install` 时只输出准备信息。Windows 启动器使用本次安装的 Python 绝对路径；移动/删除该 Python 后必须重装 helper，不能依赖 Chrome 的 PATH。

程序位于 `%USERPROFILE%\.overleaf-personal-tools\codex-native-host` 与 `native-host`；manifest 位于同一产品目录下的 `NativeMessagingHosts`。使用用户目录可避免打包版 Codex 将 LocalAppData 重定向到 MSIX 缓存，导致 Chrome 看不到同名文件。注册表使用 `HKCU\Software\Google\Chrome\NativeMessagingHosts`，只允许固定扩展 ID。遇到不属于本安装器的目录或注册项会报错，不覆盖。

Chrome 打开 `chrome://extensions`，开启开发者模式，加载 checkout 的 `dist`，然后刷新 Overleaf。实际 ID 必须与固定 ID 和两个 manifest 的 `allowed_origins` 一致。入口为 Settings → Extension → LaTeX Preview / Codex Assistant。Check connection 仅读取登录状态、模型及推理强度，不发送问题。`python -X utf8 scripts/windows-native-smoke.py` 检查已安装的同一启动器和帧协议，不能替代真实页面验收。

更新时先保留未发送草稿，等生成结束，更新源码后重新运行构建与两个安装器。在 Chrome 点击“重新加载”再刷新项目页。**不要卸载扩展来更新**，避免丢失浏览器设置。

## TeX 一次性权限配置

TeX 在无网络 capability 的 Windows AppContainer 中执行，每次编译使用独立身份，仅本次临时目录可写，并通过 Job Object 限制资源及清理全部后代。缺少隔离条件时拒绝编译，不回退到无沙盒进程；status 实际编译合成公式后才报告可用。

Windows LuaLaTeX 每次使用独立字体缓存，字体发现的文件 I/O 比其他引擎慢，墙钟时间限制为 24 秒；其他引擎仍为 14 秒。Job 的累计用户态 CPU 仍限制为 12 秒，取消无需等待该时限。Windows LuaHBTeX 1.18 的 `--safer` 会阻断 luaotfload，因此此分支使用已验证的 OS 文件/网络隔离，保留 `--nosocket`、`--no-shell-escape` 和 dotfile 限制；macOS 参数保持原样。

配置器保留原 ACL，为专用 `overleafPersonalToolsTeXRead` capability 增加 TeX 树只读/执行权限。长路径解析还需要 `texlive` 父目录和磁盘根目录本身的只读/遍历权限；这两处不向其他子目录继承。若普通账户无权修改根目录，helper 注册仍可完成，但沙盒配置会明确失败。管理员只需执行一次，例如本机：

```powershell
& 'D:\anaconda3\python.exe' -X utf8 'E:\Learning\Code\Overleaf\overleaf-personal-tools\native\windows_tex.py' --configure 'D:\texlive\2024'
```

输出 `configured: true` 后，以普通用户重跑 TeX 安装器。日常 Chrome、Codex 和 TeX 不需要管理员身份。其他安装位置需调整路径；配置器拒绝不符合布局或含 reparse point 的目录。

## 私有数据与同步边界

Windows 历史数据库、API 连接和项目缓存位于 `%USERPROFILE%\.overleaf-personal-tools\codex-assistant`，使用当前用户/SYSTEM 的受保护 ACL。这不是加密的凭据保险库；API 密钥保存在专用本机文件，不返回网页或 Chrome storage。API 对话只保存在本机，不同步到 DeepSeek 或 Codex 客户端。Codex 自己的凭据和聊天库由 Codex 管理，本扩展不搬运或直接改写它们。底层二进制文件描述符使用 `O_BINARY`，避免 Windows 文本模式改写 SQLite/原始稿件字节。

完整项目快照支持目录、搜索和分页读取；边界仍为 2,000 个文本文件、单文件 2 MiB、总计 16 MiB。项目设置提供三种模式：普通模式只使用选区等显式引用，不捕获完整项目；按需模式在项目提问时生成临时快照；本地保留模式另存只读、按版本组织的原路径文本镜像。默认按需模式，旧的仅选区设置迁移为普通模式。切换模式不会自动删除已保存版本。

临时快照仅在确认同一账号、项目的最后一个页面离开、经过 30 秒重连宽限期，且没有排队或正在使用它的请求时才可回收。页面租约是持久保存的页面存活记录，避免把后台休眠或连接中断当作页面退出；请求保护记录把某个版本与排队、已接受或结果不明的请求关联，避免回答尚在读取时删除源码。结果不明时保留数据，并且不自动重发问题。旧版快照和本地保留版本不进入自动清理。

缓存面板可查看目录、版本与空间信息、打开本机目录及显式清理。清理要求信息版本仍匹配，且没有受保护请求；被占用或状态变化时会拒绝。显式清理也移除该项目尚未完成的上传副本，其他页面若正同步会明确失败，需要重新同步。结果不明且尚无可核实的线程/轮次标识时，保护记录不会自动解除。Windows 镜像拒绝设备保留名、尾随点或空格及大小写路径冲突，不静默改名。镜像是辅助阅读副本，不是编辑回写 Overleaf 的同步目录。自动清理依赖 Chrome 后续运行与本机程序可达；浏览器关闭或连接失败时保守保留并等待后续确认。

Windows Desktop 通信使用实际安装包中核查的 named pipe 协议，与独立 app-server JSONL 是不同接口。连接前验证进程、用户 SID、登录 session、Windows 包身份、可执行路径，保留线程归属及版本检查。它仍是内部接口，未来桌面版本不兼容时会拒绝连接。

首次注册或更新项目 reader 后，已运行的 Codex 桌面需正常退出并重新打开。启动门槛比较已验证桌面进程的创建时间；独立 app-server 健康不意味着桌面已载入新 reader。历史持久化、同线程双端续聊、实时流式内容和生成中状态必须分别验收，仅最终历史出现不证明实时同步完成。

## 停用与卸载

只需临时停用时，在 Chrome 扩展管理页关闭扩展开关即可。卸载本机连接时分别运行 `python -X utf8 native/install_codex.py --uninstall` 和 `python -X utf8 native/install.py --uninstall`；安装器仅删除经过归属检查的注册项与程序目录，Codex 安装器同时移除匹配的 `overleaf_project` reader 注册。单独存放的聊天历史、API 配置和项目缓存不由程序卸载命令清空；需要删除项目源码时，先在对应项目的缓存面板检查并显式清理。不要以删除整个 `.codex` 目录或修改系统 TeX 权限作为卸载步骤。
