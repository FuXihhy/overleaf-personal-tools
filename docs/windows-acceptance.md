# Windows 开发版验收记录

公开版本已省略本机名称、用户路径及测试会话标识；版本、检查结果与证据边界保留。

以下记录对应 0.12.15。后续真实页面反馈发现连接提示与页面身份格式的遗漏，0.12.16 修复及交互验收进展见 [连接修复记录](windows-connection-acceptance.md)；不能把此处旧版基础连通确认解释为完整交互通过。

验证日期：2026-11-06。当前设备 `<redacted-device-name>`，工作目录 `<redacted-checkout-path>`，分支 `windows/install-and-compat-20261106`。用户已确认在这台设备继续。基线是私有仓库 v0.12.14、提交 `0803251324c32a2f213f39a4ece7ddac264ab126`；本地源码构建为 `0.12.15 Windows development`，固定扩展 ID 为 `pffppbkokpnfafpechmlambifflkmbbn`。没有用发布 ZIP 安装，因此不声称验证过发布 ZIP 的哈希。

## 环境与安装

Windows 10.0.26200；Chrome 156.0.8078.81；Git 2.55.0.windows.3；Node 24.19.0；pnpm 12.16.1；Python 3.11.5（安装路径已省略）；TeX Live 2024（安装路径已省略）。系统 Codex CLI 为 0.166.0，已使用本机 ChatGPT 登录；桌面包为 `OpenAI.Codex_26.1027.3384.0_x64__2p2nqsd0c76g0`，内置 native CLI 0.166.0-alpha.5.1。

两个 helper 安装在 `%USERPROFILE%\.overleaf-personal-tools` 下，避免 MSIX 对 LocalAppData 的文件重定向。Chrome HKCU NativeMessagingHosts 注册到此处的 manifest，两个 `allowed_origins` 均为固定扩展 ID。旧试装文件保留；只修复明确属于本产品的旧注册值。没有复制 Mac 凭据、历史或稿件缓存。

用户已手动加载 `dist`，在真实 Overleaf 页面确认 LaTeX Preview / Codex Assistant 两个入口；随后报告“codex连接成功，tex显示 Windows AppContainer + Job Object 沙盒可用”。最终更新后，用户再次重新加载 `0.12.15 Windows development` 并刷新专用测试项目，确认“已重新加载，三种模式和两项连接都正常”。因此最终版本的安装、三模式设置入口和两项连接已获得真实页面用户确认；下面明确区分尚未执行的完整交互验收。

## 已执行的验证及其范围

| 项目 | 证据与结论 | 限制 |
| --- | --- | --- |
| 安装与帧协议 | 已安装 `.cmd` 启动器实际启动，Codex 状态读取与模型枚举成功，TeX 状态实际编译后可用；中文、空格、百分号等路径另有真实启动器测试 | 启动器测试不等于点击真实页面 |
| Windows 私有存储 | 真实 ACL、junction、跨进程阻塞/非阻塞锁、进程退出释放锁、只读发布、全部 256 字节、SQLite 中文历史及长路径测试 | 机器缺少创建 symlink 的特权，相关测试记录跳过；另有无需该特权的真实 junction 测试 |
| 项目读取与续聊 | 两轮真实模型调用；第二轮在同一线程成功调用 MCP 读取两个合成文件，包括中文/emoji 路径，流式事件完成；helper 重启前后历史摘要一致 | 第一轮模型把 64 字符快照 ID 写成 63 字符，读取被正确拒绝；保留失败证据，第二轮是显式修正提问，不是隐式重试 |
| TeX 隔离与结果 | 三引擎实际编译；越界读写、loopback 网络、shell escape、超时、取消、断开及子进程清理均有 Windows 实测 | macOS 专用 sandbox-exec 测试在 Windows 跳过；本机结果不替代 Overleaf 云端编译测试 |
| 公式视觉检查 | `pdflatex`、`xelatex`、`lualatex` 的合成 PDF 均渲染检查，含自定义 `\cN`、Gaussian 积分、physics 宏包的 `\ket`/`\pdv`，无裁切 | 不是实际页面浮窗截图；Lua 冷字体缓存耗时 17.891 秒，Windows 墙钟上限已调为 24 秒，CPU 上限保持 12 秒 |
| API 取消 | 本机真实 HTTP 取消重复验证；自建并校验证书的 loopback HTTPS：10 次阻塞取消、2 次带间隔 Unicode 分片完成均通过，最慢取消 0.125 秒 | 无远程 API 请求，未使用用户 DeepSeek 密钥，不能证明真实供应商问答 |
| 项目缓存 | 新版已安装启动器完成 10 项合成验收：双页面、两模式版本、Unicode 原路径只读镜像、排队保护、helper 重启、31 秒宽限期后保留保护版本、释放后只回收临时版本、共享正文保留、显式清理归零 | 使用真实磁盘及 native 协议，但页面身份由测试生成；真实 Chrome 两页和 BFCache 交互另待验收 |
| Codex Desktop | 核查实际安装包 named pipe 协议；验证服务端身份后完成只读 initialize；协议与状态机测试覆盖 | 桌面进程早于 reader 注册，须正常重启；未验证实际双端续聊、实时流式显示或生成状态 |

真实模型验收只使用专用合成账号/项目范围和两个测试文本文件，未读取或修改原稿。证据分别保存在本机忽略目录 `artifacts/windows-live-acceptance.json`、`artifacts/windows-api-cancellation-tls.json` 和 `artifacts/windows-preview/`；这些文件不进入源码提交。复测脚本 `scripts/windows-live-acceptance.py` 默认不发送问题，必须显式传入 `--allow-live-turns` 才允许最多两轮测试。

最终代码冻结后的 `pnpm check` 返回 0：TypeScript 通过，56 个测试文件、924 项测试全部通过，随后构建成功（测试耗时 64.36 秒）。`python -X utf8 -m unittest discover -s native/tests -v` 返回 0：408 项中 393 项通过、15 项跳过，耗时 149.291 秒。跳过项为 7 项 macOS sandbox-exec 实测，以及 8 项需要 Windows 符号链接创建特权的测试；Windows 专用的 14 项真实 TeX 隔离、11 项 ACL/junction/锁/字节保存测试及长路径测试均实际通过。没有把跳过项计为执行通过。

最终分别重跑两个安装器，随后通过已安装启动器核实 Codex native 版本 `0.12.15`、已登录、8 个可用模型，以及 TeX native `0.2.1`、三编译器和沙盒可用，退出码均为 0。两个 host 的 14 个 Python 文件与仓库源码 SHA-256 全部一致；HKCU 的 32/64 位视图、manifest 启动器路径、固定扩展来源、`dist/manifest.json` 和实际用户目录解析均匹配。证据为 `artifacts/windows-installation-audit.json` 与 `artifacts/windows-cache-acceptance.json`。测试日志分别为仓库内忽略文件 `.frontend-check.log` 与工作目录中的 `windows-native-final-acceptance.log`。

缓存实现另经过独立代码复审；已修正队列补偿记录误释放保护、不完整页面清单触发回收、清理中断后孤儿正文漏报、缓存异常遮蔽已完成回答，以及 BFCache 前后代请求乱序等问题。最终复读没有剩余已知阻断项；这是代码审查结论，不替代下面的真实页面验收。

## 真实页面剩余验收

Computer Use 曾因无法可靠确认 Chrome 当前 URL 而自动停止。本次未改用其他浏览器控制通道绕过该限制。可以由用户在专用测试项目操作；真实原稿无需参与。工具恢复后，也可在新的交互中继续完成同一矩阵。

剩余范围包括 Code / Visual 编辑器补全、MathJax / 云端 / 本机公式浮窗、段落自定义宏、滚动导航与重新连接编辑器、主题字号和面板左右设置、选区引用清除与定位、回答引用及公式复制、用户上滚时流式阅读位置、排队/引导/停止按钮，以及两页、刷新、浏览器重启场景下三种缓存模式的真实行为。自动化测试与本机协议验证分别记录，不把它们表述为这些真实 UI 项已通过。

首次注册或更新 reader 后，正常退出并重新打开 Codex Desktop，再用合成项目验证同线程双端续聊。最终聊天记录出现、实时内容流和生成中的状态指示是三个独立检查项。真实 DeepSeek/API 验收仅在用户已自行配置目标连接后进行。
