# Windows 安装入口

Windows 支持已经合入默认分支，包括 Native Messaging 注册、私有存储、Codex Desktop named pipe、本机 TeX AppContainer 和共享的项目缓存模式。旧 v0.12.14 发布包不含这些 Windows 实现，请使用当前版本的扩展与同版本源码。

- [完整安装、更新与卸载指南](installation.md#3-windows-本机连接)：从所需功能选择组件。
- [安装脚本与真实交互验收](../acceptance/README.md)：统一脚本、合成项目及通过标准。
- [Windows 实现与权限说明](windows-development.md)：程序位置、工作区、TeX capability 和数据边界。
- [历史实测证据](../acceptance/evidence/2026-11-06/README.md)：标明具体版本与未覆盖范围；不代表新用户机器已验收。

普通 PowerShell 中，从源码根目录运行：

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --workspace 'C:\path\to\Overleaf'
```

只用自备 API、不使用 Codex 时将 `--workspace ...` 换成 `--api-only`。安装前准备 Chrome 145+、Node.js 22+、pnpm 和 Python 3.9+；脚本不会安装 Chrome、Codex 或 TeX Live。之后仍需在 Chrome 加载 `dist` 并完成真实交互检查。

源码和发布包不包含原电脑的 API 密钥、Codex 登录、聊天记录或稿件缓存；换电脑后使用自己的登录与配置。
