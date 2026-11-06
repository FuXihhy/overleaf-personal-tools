# Windows 安装与适配说明

当前浏览器扩展版本：**0.12.14**。本机 Codex/API 连接版本：**0.12.12**。

这个仓库同时包含 LaTeX Preview 和 Codex Assistant 的完整实现。当前 macOS 本机连接不能直接在 Windows 上运行；Windows 浏览器部分尚未完成实机验收。

## 下载后加载扩展

1. 在 Windows 上登录有权访问此私有仓库的 GitHub 账号，打开仓库的 Releases。
2. 下载 `overleaf-personal-tools-0.12.14.zip`，解压到一个固定目录。不要直接加载 ZIP，也不要随后删除或移动这个目录。
3. 使用 Chrome 145 或更新版本，在 `chrome://extensions` 开启开发者模式，点击“加载已解压的扩展程序”，选择解压后包含 `manifest.json` 的目录。
4. 刷新已登录的 Overleaf 项目页，打开 **Settings → Extension → LaTeX Preview / Codex Assistant**。

浏览器补全、MathJax 预览和 Overleaf 云端预览不需要配套本机程序，可先在 Windows 上测试。云端预览仍按界面提示配置其预览工作区。

**Codex、DeepSeek 和其他兼容 API 都经过本机连接程序。** 当前 Windows 上显示这些设置入口，不代表连接已经可用。不要运行现有的 macOS 安装命令来尝试完成 Windows 安装。本机 TeX 也需要单独适配。

## 在 Windows 上继续开发

下载 `overleaf-personal-tools-0.12.14-source.zip` 并解压，或克隆此私有仓库。源码 ZIP 包含测试、文档、锁文件和本机代码，浏览器 ZIP 则用于直接加载。

安装 Node.js 22+ 和 pnpm 后，在源码目录运行：

```sh
pnpm install --frozen-lockfile
pnpm check
```

构建结果在 `dist`，加载其中包含 `manifest.json` 的目录。以上是项目构建命令；Windows 端测试或构建若失败，应保留错误供适配排查。

主要代码入口：

| 功能 | 路径 |
| --- | --- |
| 预览与编译 | `src/preview/`、`native/host.py` |
| 编辑器接入与选区 | `src/overleaf/` |
| Codex Assistant 与 API 设置 | `src/codex/`、`src/settings/` |
| Codex / API 本机连接 | `native/codex_host.py`、`native/api_provider.py` |
| 安装器 | `native/install.py`、`native/install_codex.py` |
| 项目缓存与读取工具 | `native/project_context.py`、`native/manuscript_mcp.py` |
| 桌面对话通信 | `native/desktop_ipc.py`、`native/desktop_state.py` |

适配工作包括 Windows Native Messaging 注册和启动器、文件锁及访问权限、数据目录、Codex 程序发现与桌面通信，以及本机 TeX 的隔离执行。先完成 AI 连接和项目读取，再单独验收本机 TeX。已有的桌面实时生成状态同步限制也仍需处理，不能仅凭历史可读判断实时同步完成。

## 更新与数据

后续手动下载新版本，替换扩展目录后在扩展管理页点“重新加载”，再刷新 Overleaf。不要卸载扩展来更新，以免丢失浏览器保存的设置。

源码和发布包不包含原电脑上的 API 密钥、Codex 登录、聊天记录、项目缓存或机器专属的 `workspace.json`。这些数据不会因为克隆仓库自动迁移。
