# 0.12.16 连接修复与真实交互验收

日期：2026-11-06；设备与安装目录延续 [Windows 安装说明](windows-development.md)。用户报告关闭本地 Codex 后仍显示 Connected，发送时却出现 `A verified Chrome project document is required for project caching`。本次先修复这两个问题，再继续真实页面验收；不把自动化测试等同于实际页面完成。

## 根因与修复

旧版页面租约校验强制 `sender.documentId` 使用 36 字符、带连字符的 UUID 排版；Chromium 实现使用 32 字符十六进制标识，因此合法 Chrome 项目页被拒绝。旧测试的 sender 全部由 `crypto.randomUUID()` 构造，未覆盖真实格式。[Chromium 的 DocumentIdFromString 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/extension_api_frame_id_map.cc)

现在把 Chrome 提供的 documentId 作为不依赖排版的身份字符串，并和可信 tab ID 一起散列成 native 可用的身份。仍校验本扩展 sender、顶层 frame、精确 Overleaf HTTPS 来源、项目/账号范围，不接受网页自报身份。原有页面租约保留兼容路径，真实新文档由完整页面清单正常替换旧身份。失败消息使用固定原因码，不输出账号、正文或完整 URL。

旧版 `status` 只读取登录信息和模型目录，随后声称 Connected；实际上它启动的是独立 Codex app-server，桌面窗口关闭不等于这个后台不可用。新版返回 `connectionKind: standalone`，并实际检查 `overleaf_project` 的目录、搜索和读取三个工具，分别返回 `projectReaderReady` 与经过脱敏的 `readerError`。这些检查不创建聊天、不发送模型请求、不声称桌面连接或当前聊天写入权已验证。模型列表也不能单独证明推理请求可成功。[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)、[模型目录与推理验证的区别](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

界面成功标签改为“本机后台已检查”，提示说明独立后台、检查时间与检查边界。完整项目同步失败显示黄色受阻状态；关闭通知、模型目录缓存命中或迟到的成功检查不能清除它。真正的 native 连接失败与项目页面注册失败分别处理。发送前失败保留草稿和引用，不调用 ask、不自动重发；尚未验证项目 reader 时，普通上下文仍可使用。手动同步期间切换模式会使旧捕获结果失效。

## 已完成的验证

冻结后的 `pnpm check` 返回 0：TypeScript 通过，56 个测试文件、965 项测试全部通过，随后构建 `dist` 成功（测试 60.79 秒）。`python -X utf8 -m unittest discover -s native/tests -v` 返回 0：413 项中 398 项通过、15 项按原有平台/权限条件跳过（141.788 秒）。本次新增的真实 Chrome 身份、旧租约迁移、状态覆盖、强制重新检查和模式切换回归均实际执行。

已重装 Codex native `0.12.16`，并通过真实安装启动器读到 `available=true`、`authenticated=true`、8 个模型、`connectionKind=standalone`、`projectReaderReady=true`，退出码 0。该结果不包含模型推理或桌面握手。TeX 代码本轮未改，Windows TeX 专用测试仍在上述完整回归中执行通过。日志位于工作目录 `windows-frontend-0.12.16.log`、`windows-native-0.12.16.log`。

本轮通过 Chrome Browser API 创建专用 [OPT Windows Acceptance 2026-11-06](https://www.overleaf.com/project/6aed6fe1c7faaec064ddfb2a)，只写入合成 `main.tex`、`chapter.tex`。其中两个哨兵为 `OPT-MAIN-7A91` 与 `OPT-CHAPTER-63B8`，用于后续跨文件读取验证。在旧版真实页面点击 Sync project cache，确切复现相同的 Chrome document 校验错误；同时模型列表成功载入。合成项目也成功执行过 Overleaf 常规云端编译。未改动原稿项目，未在此项目发送模型问题。

## 当前阻断与下一步

`chrome://extensions` 无法被 Browser API 认领。尝试读取当前 Windows Chrome 扩展管理窗口时，Computer Use 的自动安全检查因无法可靠确认当前 URL 而停止本轮操作；没有进一步操作页面或切换通道规避停止。因此，**修复后的实际页面同步、徽标与问答尚未验证**，不能宣称完整交互验收完成。

当前 `dist` 已构建为 `0.12.16 Windows development`；用户手动重新加载现有扩展后，下一轮直接进入上述测试项目继续。先确认 Sync project cache 成功和明确的后台/项目状态，再以 `gpt-6-luna / low` 做限定的跨文件读取、刷新后的同线程历史与续聊；之后逐项检查选择引用、回答引用、停止/排队/引导、滚动、Code/Visual 补全与预览、面板设置、缓存多页生命周期和 Desktop 交接。真实外部 API 服务需要用户已配置对应连接；本机合成 API 测试只证明协议和界面路径，不替代真实服务验证。
