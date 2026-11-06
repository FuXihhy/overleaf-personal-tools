# Overleaf Personal Tools

为 Overleaf 增加项目命令补全、公式预览和文稿问答的 Chrome 扩展。支持 Overleaf 英文站与中文站，设置嵌入原有 **Settings → Extension**，界面跟随网站语言和主题。

这是独立的非官方工具，与 Overleaf、OpenAI 或 API 服务商没有隶属或背书关系。目前通过 GitHub 源码和解压扩展分发，未在 Chrome Web Store 上架。

**开始使用：[安装指南](docs/installation.md) · [使用说明](docs/usage.md) · [数据与权限](docs/privacy.md) · [下载 Releases](https://github.com/FuXihhy/overleaf-personal-tools/releases)**

## 能做什么

- **项目命令补全**：读取主文件、宏包和自定义宏，在 Overleaf 原有补全列表中显示来源与参数模板，选择后插入，可正常撤销。
- **LaTeX Preview**：在 Code 和 LaTeX Visual 编辑中预览公式。MathJax 即时显示；TeX 模式使用 Overleaf 云端或本机 TeX Live 编译，停顿后替换即时草稿。
- **Codex Assistant**：对选区、附近正文或完整项目提问，支持文稿与回答引用、流式回答、历史、排队、支持条件下的引导，以及保留 LaTeX 的复制。可使用本机 Codex 登录，也可使用自己的 DeepSeek／兼容 API。
- **项目缓存控制**：普通上下文、按需缓存、本地保留三种模式，提供版本与空间检查和显式源码清理。聊天记录与源码缓存分别管理。

扩展提供阅读、预览和问答，不自动把模型回答写回 Overleaf。采纳建议前，请自行检查并编辑文稿。

## 选择需要的组件

| 功能 | 浏览器扩展 | 本机连接程序 | 其他条件 |
| --- | --- | --- | --- |
| 命令补全、MathJax | 必需 | 不需要 | Chrome 145+、已登录 Overleaf 项目 |
| Overleaf 云端 TeX | 必需 | 不需要 | 专用云端预览项目及账号编译资源 |
| Codex 问答 | 必需 | Codex/API helper | 本机可用且已登录的 Codex |
| 自备 API 问答 | 必需 | Codex/API helper | 自己的 API 地址、模型和密钥；无需 Codex |
| 本机 TeX | 必需 | TeX helper | TeX Live；macOS 沙盒或 Windows AppContainer |

**macOS 和 Windows 均有本机实现。** Windows 的实测范围见 [验收记录](docs/windows-connection-acceptance.md)和[合成项目证据](acceptance/evidence/2026-11-06/README.md)。macOS 0.12.18 已完成自动回归及真实 Chrome 中的两文件同步、跨文件问答、停止后部分回答与刷新恢复，以及本机 TeX 预览检查，详见 [Mac 验收范围](docs/mac-acceptance.md)。Linux、本仓库未列出的浏览器，以及自托管 Overleaf 尚未纳入安装与验收范围。

只用补全和浏览器预览，可以只下载预构建的扩展 ZIP。需要问答或本机 TeX，还要取得**同一版本**的源码并按安装指南注册对应 helper；Chrome 加载扩展不会替你安装本机程序。

## 快速开始

1. 从 [Releases](https://github.com/FuXihhy/overleaf-personal-tools/releases) 获取所需版本，或获取仓库源码后运行 `pnpm install --frozen-lockfile` 和 `pnpm build`。源码构建需要 Node.js 22+、pnpm。
2. 在 Chrome 打开 `chrome://extensions`，开启开发者模式，选择“加载已解压的扩展程序”。预构建 ZIP 选择含 `manifest.json` 的解压目录；源码构建选择 `dist`。
3. 刷新 Overleaf 项目页，进入 **Settings → Extension**，选择 **LaTeX Preview** 或 **Codex Assistant**。需要本机功能时继续按 [macOS / Windows 安装步骤](docs/installation.md)操作。
4. 用[随仓库提供的合成项目](acceptance/project)完成首次检查。看到“后台已检查”只说明后台健康；实际问答、源码读取、停止后历史保留和公式预览需分别验证。

更新时保留未发送草稿，等待当前回答结束，更新扩展与需要更新的 helper，再在 Chrome 重新加载扩展并刷新项目页。无需通过卸载扩展来更新。首次注册或更新 Codex 项目 reader 后，还需正常退出并重新打开 Codex。

## 数据与边界

补全和 MathJax 在浏览器内处理。云端 TeX 将公式、导言区及所需文本依赖同步到账号下的专用 Overleaf 预览项目；助手仅在你发送或继续队列时，把问题和选定上下文交给所选 Codex 服务或 API。所谓“本机连接”不表示模型离线运行。

API 密钥由本机 helper 保存在权限受限的文件中，不写入 Overleaf 页面或 Chrome storage；它不是系统凭据保险库。API 聊天与 Codex 聊天分开，API 历史不会出现在 Codex 桌面。源码缓存、聊天、API 配置、云端预览项目各有自己的保留规则，卸载不等于清空全部数据，详见[数据与权限](docs/privacy.md)。

本工具依赖 Overleaf 编辑器和部分 Codex Desktop 内部接口，网站或桌面更新可能影响兼容性。MathJax 不执行任意 TeX；TeX 单公式预览也不能完整重现正文状态、外部工具或所有二进制资源。完整项目上下文当前限于文本文件，上限为 2,000 个文件、单文件 2 MiB、合计 16 MiB。遇到不完整或无法验证的源码，不会把节选冒充完整项目。

## 开发与反馈

```sh
pnpm install --frozen-lockfile
pnpm check
python3 -m unittest discover -s native/tests -v
python3 -m unittest discover -s scripts/tests -v
```

Windows 将上面的 `python3` 换成 `python -X utf8`。测试会明确报告平台相关跳过；跳过不代表通过。`pnpm check` 包含类型检查、前端测试和构建，不安装 helper、不发送模型请求。开发页面与架构分别见 [dev/README.md](dev/README.md)、[架构说明](docs/architecture.md)。

问题请提交到 [Issues](https://github.com/FuXihhy/overleaf-personal-tools/issues)，附扩展、操作系统、Chrome 和相关后端版本、复现步骤与合成项目。请先移除密钥、登录文件、真实文稿和私人聊天。版本变化见 [CHANGELOG](CHANGELOG.md)。

本项目采用自定义[源码可见许可证](LICENSE)：日常工作、教学和论文写作可免费使用；销售扩展、纳入商业产品或提供付费服务，需事先取得书面授权。分发修改版或提供修改后的在线服务，须向接收者／服务用户提供完整对应源码；仅在本机私下修改无需公开。详见[许可说明与授权联系](docs/licensing.md)。这不是 OSI 开源许可证，第三方依赖、素材和商标不在本项目的授权范围内。
