# 安装、更新与卸载

先选择需要的功能，再安装对应组件。补全、MathJax 与 Overleaf 云端预览只需浏览器扩展；Codex／自备 API 问答需要 Codex/API helper；本机 TeX 另需 TeX helper 和 TeX Live。两个 helper 分别安装，互不替代。

以下命令均在**源码根目录**执行。目录应保留在固定位置；Chrome 会持续从你选择的扩展目录读取文件。不要混用旧版预构建扩展和新版 helper。

## 1. 准备环境与扩展

| 组件 | 要求 | 何时需要 |
| --- | --- | --- |
| Google Chrome | 145 或更新版本 | 所有功能；其他 Chromium 浏览器未纳入本安装流程 |
| Overleaf | 已登录的 `www.overleaf.com` 或 `cn.overleaf.com` 项目 | 所有功能；自托管站点不匹配当前 manifest |
| Node.js、pnpm | Node.js 22+，可用的 pnpm | 从源码构建；Windows 统一安装脚本 |
| Python | 3.9+；macOS helper 固定使用 `/usr/bin/python3` | 本机连接；Windows 使用安装时的 Python 绝对路径 |
| Codex | 本机已安装、可正常登录使用 | Codex 模式；自备 API 模式无需安装 Codex |
| TeX Live | macOS 为 MacTeX／系统 TeX Live；Windows 为 TeX Live | 仅本机 TeX；Windows 另需同一 Python 中的 `pywin32` |

从 [Releases](https://github.com/FuXihhy/overleaf-personal-tools/releases) 下载预构建扩展和所需的同版本源码；也可在 GitHub 使用 **Code → Download ZIP** 获取当前源码。使用 Git 时：

```sh
git clone https://github.com/FuXihhy/overleaf-personal-tools.git
cd overleaf-personal-tools
pnpm install --frozen-lockfile
pnpm build
```

预构建扩展无需 Node.js 或 pnpm。源码构建的输出为 `dist`；源码目录本身虽然有 `manifest.json`，但尚未包含构建后的脚本，**不要把源码根目录加载成扩展**。

在 Chrome 打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”：

- 预构建 ZIP：选择直接包含 `manifest.json`、`background.js`、`content.js` 的解压目录。
- 源码构建：选择源码目录下的 `dist`。

固定扩展 ID 应为 `pffppbkokpnfafpechmlambifflkmbbn`。`manifest.json` 中的 `key` 是用于稳定该 ID 的**公钥**，不是用户凭据；不要删除它。helper 的注册只允许此扩展来源。

刷新 Overleaf 项目页或由 Chrome 承载的 Overleaf 独立窗口，进入 **Settings → Extension**。应出现 **LaTeX Preview** 与 **Codex Assistant** 两个子项；助手面板入口在左侧原有 AI assistant 下方。独立窗口必须使用安装扩展的同一个 Chrome 用户配置。

## 2. macOS 本机连接

先执行 `/usr/bin/python3 --version` 确认固定运行时可用。若不可用，先完成 Apple Command Line Tools 的安装；单独安装另一份 Python 并不会改变当前 Mac helper 的固定启动路径。无需使用 `sudo`。

### 使用 Codex

先正常安装并登录 Codex。若希望新聊天使用指定本地工作目录，请先把该目录作为项目添加到 Codex，再执行：

```sh
/usr/bin/python3 native/install_codex.py --install --workspace '/absolute/path/to/Overleaf'
```

把示例换成**已存在的绝对目录路径**，不是 Overleaf 网页地址，也不必是扩展源码目录。安装器查找对应的已有 backend 项目，不自动新建项目。工作目录及 backend 项目绑定不保证桌面侧栏已经归类；需要时在 Codex 用 **Move / 移动到项目**，并检查实际结果。

不指定工作区也能安装：

```sh
/usr/bin/python3 native/install_codex.py --install
```

这会保留已有绑定；首次安装且没有绑定时，使用 helper 的私有数据目录作为新会话工作目录。安装器会注册专用 Chrome host 和只读 `overleaf_project` MCP reader。首次安装或 reader 更新后，正常退出并重新打开一次 Codex，再在 Chrome 重新加载扩展并刷新 Overleaf。

### 只使用自己的 API

```sh
/usr/bin/python3 native/install_codex.py --install --api-only
```

此路径不要求 Codex 程序或登录，不修改 Codex MCP 注册。随后按第 4 节配置连接。以后要启用 Codex 项目读取，再运行不带 `--api-only` 的 Codex 安装命令。

### 可选：本机 TeX

macOS helper 通过 `/Library/TeX/texbin` 识别 `/usr/local/texlive` 下的系统 TeX Live／MacTeX。先安装所需发行版与宏包，再注册：

```sh
/usr/bin/python3 native/install.py --install
```

在 **LaTeX Preview** 选择 **TeX → Local / 本机**，选择实际可用的 pdfLaTeX、XeLaTeX 或 LuaLaTeX，点击检查本机连接，再预览合成公式。缺少沙盒或兼容 TeX 时会报错，不退回无沙盒编译；个人 `~/texmf`、用户字体和项目二进制资源不在当前预览范围内。详见 [本机 TeX 的隔离与限制](native-backend.md)。

不带 `--install` 或 `--uninstall` 运行任一安装器，只显示准备信息，不修改文件。Mac 注册位置与数据目录见[数据与权限](privacy.md#本机位置与保留规则)。

## 3. Windows 本机连接

打开普通 PowerShell，进入源码根目录。先确认 `node --version`、`pnpm --version`、`python --version` 可用；如果刚安装工具，重新打开终端。使用 Codex 时先登录，并添加一个已有本地项目目录：

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --workspace 'C:\path\to\Overleaf'
```

脚本安装锁定的 JavaScript 依赖、构建 `dist`、注册两个本机 host，并检查安装副本与 Codex 后台健康。默认不配置 TeX 权限、不发送模型请求、不替你操作 Chrome。之后仍须按第 1 节加载 `dist` 并完成首次真实检查。

只使用自备 API 时：

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --api-only
```

此路径跳过 Codex 登录和 reader 注册。复查时继续带上 `--api-only`。已经安装后，只做安装与后台检查可省略 `--setup`：

```powershell
python -X utf8 scripts/windows-acceptance.py
```

报告写入 `artifacts/windows-acceptance.json`，合成项目 ZIP 写入 `artifacts/acceptance-project.zip`。`PASS`、`FAIL`、`SKIP`、`MANUAL` 分别表示自动通过、失败、跳过和待人工检查；正常安装后仍有 `MANUAL` 项，不表示安装失败。`--full` 另运行开发回归；`--local-tex` 检查已有 TeX 隔离，不改变权限。

### 可选：Windows 本机 TeX

先安装 TeX Live。首次配置时明确提供其根目录，例如：

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --workspace 'C:\path\to\Overleaf' --tex-root 'C:\texlive\2026'
```

API-only 用户将 `--workspace ...` 换成 `--api-only`。脚本会在同一 Python 缺少 `pywin32` 时安装它，再配置专用 TeX capability。仅在明确提示权限不足时，按终端给出的命令完成一次权限配置；脚本不自动提权，日常 Chrome、Codex 和 TeX 仍以普通用户运行。不要关闭隔离来绕过失败。

验证已有配置：

```powershell
python -X utf8 scripts/windows-acceptance.py --local-tex
```

Windows 使用 AppContainer + Job Object 隔离编译，安装位置和详细机制见 [Windows 实现说明](windows-development.md)。安装后移动或删除 Python 会使固定启动器失效，需用可用的 Python 重新安装 helper。

## 4. 首次设置与实际检查

打开 **Settings → Extension → Codex Assistant**，查看本机后台检查结果。它检查登录、模型目录和项目 reader 等能力，**不等于已经完成模型推理、项目同步或桌面连接**。源码错误会单独保留，重新检查后台不能清除源码问题。

使用 API 时点击 **Manage API connections / 管理 API 连接**，在扩展专用设置页新建连接，填写服务地址、模型和自己的密钥。保存后可检查 `/models`；成功读取目录仍需用实际问答确认模型。返回项目设置刷新连接列表，选择 **Model source / 模型来源** 和模型；项目设置自动保存。更换服务地址要新建连接；编辑现有连接时空密钥保留原值。

初次测试使用 `acceptance/project/main.tex` 和 `chapter.tex`，不要用私人稿件。Windows 脚本会生成 ZIP；macOS 可在 Finder 中选中这两份文件并压缩，再把 ZIP 上传为新的 Overleaf 项目。两份文件应位于项目根目录。Windows 和 Mac 都可复用[验收指南中的问题与通过标准](../acceptance/README.md)。至少完成：

1. 进入测试公式，确认 MathJax 预览；需要本机／云端 TeX 时分别等待真实编译结果。
2. Codex 选择按需缓存，点击 **Sync project cache**，确认两文件同步；发送跨文件问题并核对 `OPT-MAIN-7A91` 与 `OPT-CHAPTER-63B8`。API 用户先用普通上下文验证短回答；跨文件工具读取要求服务支持 function calling。
3. 刷新页面，确认同一会话历史保留。对长回复点击 Stop 后再次刷新，确认已经显示的部分回答保留，问题没有自动重发。

首次测试会按所选 Codex／API 服务产生模型用量。完整的引用、排队、桌面续聊和缓存检查见[验收矩阵](../acceptance/README.md#可选功能与完整交互检查)。未做的项记为未测。

## 5. 更新

先等待当前回答结束，保存未发送草稿。更新源码或获取同版本发布包；从源码安装的用户重新运行 `pnpm install --frozen-lockfile`、`pnpm build`。

- macOS：需要更新助手时重跑 `native/install_codex.py --install`；API-only 用户继续加 `--api-only`。使用本机 TeX 时重跑 `native/install.py --install`。均使用前述 `/usr/bin/python3`。
- Windows：重跑 `windows-acceptance.py --setup`，保留相应 `--workspace` 或 `--api-only` 选项；需要 TeX 时按原配置复查。
- Chrome：在扩展管理页点“重新加载”，然后刷新所有已打开的 Overleaf 项目页。只重新加载扩展不会替换旧页面里的内容脚本。
- Codex：首次注册或 reader 更新后，正常退出并重新打开，使桌面载入新 reader。

更新保留本机历史、API 配置和既有工作区绑定。不要用卸载扩展来更新，也不要从另一台电脑复制密钥、登录文件或整个 `.codex` 目录。

## 6. 停用与卸载

临时停用：关闭 Chrome 扩展开关并刷新 Overleaf。删除扩展：在 `chrome://extensions` 中移除；这会移除浏览器扩展数据，不能当作普通更新步骤。

在源码根目录分别卸载使用过的 helper：

```sh
# macOS
/usr/bin/python3 native/install_codex.py --uninstall
/usr/bin/python3 native/install.py --uninstall
```

```powershell
# Windows
python -X utf8 native/install_codex.py --uninstall
python -X utf8 native/install.py --uninstall
```

纯 API 安装可在助手卸载命令后加 `--api-only`，跳过 Codex MCP 操作。如果曾注册 Codex reader，应使用普通卸载，安装器会拒绝以 API-only 方式留下失效 reader。普通助手卸载移除匹配的 reader 注册。安装器只删除归属匹配的注册项与程序目录，保留另存的聊天历史、API 连接和源码缓存；不卸载 Codex、TeX Live，也不删除 Overleaf 项目。

需要移除某项目本机源码时，在卸载前打开该项目的缓存面板，先 **Inspect local versions**，再使用 **Clear retained source** 并确认范围。清理后聊天可能仍引用已不存在的旧版本；重新同步只能得到当时的当前源码。云端预览项目需在 Overleaf 单独管理。详细保留规则见[数据说明](privacy.md)。

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 没有 Extension 入口 | 核对加载的是 `dist` 或预构建目录、固定 ID、Chrome 用户配置和站点域名；重新加载扩展并刷新项目页 |
| `Extension context invalidated` | 保存草稿后刷新页面；该错误表示页面持有已经失效的旧扩展上下文 |
| Service Worker 显示“不活动” | 空闲休眠是正常状态；以实际连接结果判断，不据此反复重装 |
| 找不到 Native Messaging host | 用相同系统用户重跑对应安装器；检查固定 ID；Windows 确认安装时的 Python 没有移动 |
| 后台已检查，但缓存同步失败 | 等 Overleaf 保存，点 Sync project cache 并按源码错误处理；后台健康与源码同步是两项检查 |
| reader 更新后桌面仍读不到项目 | 正常退出并重新打开 Codex；桌面读取的是同步过的版本，不会在网页关闭后自行抓取 |
| 工作区找不到或聊天未出现在桌面项目下 | 确认目录已在 Codex 添加为项目；桌面侧栏归类另用 Move 检查，不猜填项目 ID |
| 公式有 MathJax 草稿但没有 TeX 图像 | 查看所选 TeX 后端状态与错误；草稿不代表编译成功；检查宏包、依赖与沙盒 |
| API 模型目录正常但提问失败 | 确认所选模型支持 `/chat/completions`；项目工具读取还需 function calling；不会自动换服务或重发 |
| 保留镜像报告路径冲突或被编辑 | 镜像用于只读查看；不要在该目录改稿。检查源项目文件名，保留原版本后再决定显式清理和同步 |

反馈请附版本、复现步骤及合成项目结果。错误报告和截图可能带有本机路径或项目标识，分享前请移除不需要的个人信息。
