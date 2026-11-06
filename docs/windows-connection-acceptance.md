# 0.12.16–0.12.17 连接修复与真实交互验收

可在 GitHub 直接查看的合成项目截图与结构化摘要已整理到[本轮验收证据](../acceptance/evidence/2026-11-06/README.md)。其他用户重新安装时应使用[安装与验收指南](../acceptance/README.md)，不要把下面的维护者实测结果当作自己机器已通过。

公开版本已用明确占位符替换本机路径与合成项目、聊天、轮次、快照的标识；这不改变以下历史验证结论，也不表示 Git 历史已清除这些旧标识。

日期：2026-11-06；设备与安装目录延续 [Windows 安装说明](windows-development.md)。用户报告关闭本地 Codex 后仍显示 Connected，发送时却出现 `A verified Chrome project document is required for project caching`。本次先修复这两个问题，再继续真实页面验收；不把自动化测试等同于实际页面完成。

## 根因与修复

旧版页面租约校验强制 `sender.documentId` 使用 36 字符、带连字符的 UUID 排版；Chromium 实现使用 32 字符十六进制标识，因此合法 Chrome 项目页被拒绝。旧测试的 sender 全部由 `crypto.randomUUID()` 构造，未覆盖真实格式。[Chromium 的 DocumentIdFromString 实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/extensions/browser/extension_api_frame_id_map.cc)

现在把 Chrome 提供的 documentId 作为不依赖排版的身份字符串，并和可信 tab ID 一起散列成 native 可用的身份。仍校验本扩展 sender、顶层 frame、精确 Overleaf HTTPS 来源、项目/账号范围，不接受网页自报身份。原有页面租约保留兼容路径，真实新文档由完整页面清单正常替换旧身份。失败消息使用固定原因码，不输出账号、正文或完整 URL。

旧版 `status` 只读取登录信息和模型目录，随后声称 Connected；实际上它启动的是独立 Codex app-server，桌面窗口关闭不等于这个后台不可用。新版返回 `connectionKind: standalone`，并实际检查 `overleaf_project` 的目录、搜索和读取三个工具，分别返回 `projectReaderReady` 与经过脱敏的 `readerError`。这些检查不创建聊天、不发送模型请求、不声称桌面连接或当前聊天写入权已验证。模型列表也不能单独证明推理请求可成功。[OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)、[模型目录与推理验证的区别](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

界面成功标签改为“本机后台已检查”，提示说明独立后台、检查时间与检查边界。完整项目同步失败显示黄色受阻状态；关闭通知、模型目录缓存命中或迟到的成功检查不能清除它。真正的 native 连接失败与项目页面注册失败分别处理。发送前失败保留草稿和引用，不调用 ask、不自动重发；尚未验证项目 reader 时，普通上下文仍可使用。手动同步期间切换模式会使旧捕获结果失效。

## 已完成的验证

冻结后的 `pnpm check` 返回 0：TypeScript 通过，56 个测试文件、965 项测试全部通过，随后构建 `dist` 成功（测试 60.79 秒）。`python -X utf8 -m unittest discover -s native/tests -v` 返回 0：413 项中 398 项通过、15 项按原有平台/权限条件跳过（141.788 秒）。本次新增的真实 Chrome 身份、旧租约迁移、状态覆盖、强制重新检查和模式切换回归均实际执行。

已重装 Codex native `0.12.16`，并通过真实安装启动器读到 `available=true`、`authenticated=true`、8 个模型、`connectionKind=standalone`、`projectReaderReady=true`，退出码 0。该结果不包含模型推理或桌面握手。TeX 代码本轮未改，Windows TeX 专用测试仍在上述完整回归中执行通过。日志位于工作目录 `windows-frontend-0.12.16.log`、`windows-native-0.12.16.log`。

本轮通过 Chrome Browser API 创建专用 **OPT Windows Acceptance 2026-11-06**（项目 ID 已省略），只写入合成 `main.tex`、`chapter.tex`。其中两个哨兵为 `OPT-MAIN-7A91` 与 `OPT-CHAPTER-63B8`，用于后续跨文件读取验证。在旧版真实页面点击 Sync project cache，确切复现相同的 Chrome document 校验错误；同时模型列表成功载入。合成项目也成功执行过 Overleaf 常规云端编译。未改动原稿项目，未在此项目发送模型问题。

## 真实 Chrome 验收进展

用户重新加载后，真实页面的 Sync project cache 成功：2 文件，重复同步复用本机正文。面板显示 `Codex · Local service checked`，设置明确说明尚未验证模型推理。专用聊天 `<synthetic-conversation-A>` 首轮使用 `gpt-6-luna / low`，问题没有泄露哨兵值，准确回答 `main.tex: OPT-MAIN-7A91` 与 `chapter.tex: OPT-CHAPTER-63B8`。对此准确 ID 的只读 canonical 审计证明，两次 `overleaf_project/read_project_file` 分别读取两文件并完成，没有工具错误。刷新后同会话问答恢复。

第二轮实际出现连续流式输出及公式渲染。只排入一条追问，向上滚动后出现 Jump to latest；Stop 最终显示 Stopped，canonical 状态为 interrupted。队列保持一条暂停项，刷新后仍保留；手动 Resume queue 后只提交一次，第三轮返回 `QUEUE_OK-7A91`，队列清空。源文选区跨焦点保留、Go to source 和移除，回答文字的 Quote selected text、定位和移除，以及面板左右切换均实际操作。用户分别确认 Desktop 能看到首轮两行回答和第二轮问题；这不能证明 Desktop 实时回答、生成指示或 writer 交接，精确 ID 的只读 discover_owner 当时仍无 owner。

MathJax 自定义 `\cN` 浮窗、Code 模式的 Gaussian 积分/physics 偏导本机 TeX 浮窗，以及 Visual 点入自定义宏后的本机 TeX 浮窗均通过。TeX 结果用 `data-opt-render-kind=tex` 和完整加载的 `TeX formula preview` 图片确认，未把即时草稿当编译结果。源码输入 `\c` 时原生列表出现带 `main.tex` 来源的 `\cN` 和 physics 项，选择后插入，Undo 撤销后源码与测试前完全一致。

云端预览创建并保留一个共享工作区 `<synthetic-preview-project>`（Overleaf Personal Tools — Preview）。首次目录读取超时，手动 Check 同一项目后成功，随后真实公式 TeX 图片成功，未重复创建工作区。首次连接失败不是目录字段漂移的证明；共享项目仅保留合成导言区/公式。原稿未用于验收。

缓存基线为 1 temporary、461 bytes、3 真实页面、0 pins。仅切 Keep project locally 不改变版本，Sync 后同一快照晋升 persistent，变为 922 bytes（正文 461 + 镜像 461）；切回 On-demand 不降级。原路径只读镜像中的 main.tex 350 bytes、chapter.tex 111 bytes 均逐字节及 SHA-256 匹配，ACL 无写数据/追加数据权限。Open source folder 打开的 Explorer 窗口标题与该 scope 匹配。合成 main.tex 已追加唯一注释 `% OPT_CACHE_REV_20261106_B`，用于后续新 temporary 生命周期检查。

截图证据位于忽略目录 `artifacts/windows-ui-*-0.12.16.jpg`，包括同步、跨文件答案、活动队列、停止、恢复队列、回答引用、补全、本机与云端公式预览。只保留合成项目内容。

## 验收中新发现的问题与 0.12.17

停止第二轮时已显示约 85 条内容，但 canonical interrupted turn 没有 agentMessage。本地保存的 partial 随后被历史合并删除，确认是实际 bug。现已修复：缺少正式答案的 interrupted turn 保留本地已接收文本；按 item ID 合并已完成与流式片段；Desktop 空 active/interrupted 快照不抹掉已有文本。后来非空正式答案仍替换去重，completed 空答案仍可清除旧稿。修复前已经删除的第二轮内容无法据此恢复，不能声称恢复了原内容。

另修复引擎切换后设置页残留先前云端超时的问题：错误有请求归属，成功只清除自己仍持有的错误，保留更新的设置和索引状态；迟到草稿不覆盖真实 TeX 结果。

0.12.17 完整 `pnpm check` 返回 0：56 suites、971 tests 全通过，TypeScript 与 dist 构建成功（64.18 秒）。原生完整回归 421 项，406 通过、15 条件跳过，138.026 秒；没有把跳过计入通过。已重装 native 0.12.17，实际启动器 status 返回 available/authenticated/projectReaderReady 为 true、standalone、8 模型，退出码 0；用户已确认重新加载。日志为工作目录 windows-frontend-0.12.17.log、windows-native-0.12.17.log。

## 0.12.17 实际复测

用户重载 0.12.17 后，第 4 轮 `<synthetic-turn-4>` 实际输出 `PARTIAL_KEEP_OK` 和公式；运行中发送一次 Steer 后，后续 28 行带 `STEER_ACK`。Stop 得到 interrupted，刷新后保留 2113 字符。canonical 仍没有 agentMessage，但本地只有一个合并后的助手记录，SHA-256 为 `58b39e7f792cf1aad1d8642e3e9a13d688faa67fd5119493d5cff794d7b9fce3`，后续同步未变。第一次发送前遇到账户连接超时，草稿恢复；确认后台没有新增 turn 后才手动重试，没有自动重发。

用户随后在同一 Desktop 聊天发送“这是双端验收，请只回答 DESKTOP_ORIGIN_OK”。第 5 轮 `<synthetic-turn-5>` completed，网页自动出现该问题和回答，native 与 canonical 各有唯一 user/assistant，回答 SHA-256 一致。第 4 轮部分回答仍保持原哈希。此项证明桌面发起的最终问答回流，不扩大为双方实时生成指示或 writer 交接全部分支已验证。

用户自行在扩展设置页添加 DeepSeek 并授权实测；密钥未读取或输出。选择其 `https://api.deepseek.com` / `deepseek-flash`，普通上下文只发送合成测试内容。API 独立聊天 `<synthetic-api-conversation>` 第 1 轮完成 `DS_API_OK` 和公式；第 2 轮生成过快，正常完成，未计作取消成功；第 3 轮 Thinking 时点击 Stop，最终 cancelled、没有空助手消息、没有自动重发。真实历史共 3 个 turn、3 个用户消息和 2 个助手消息，刷新恢复。切回 Codex 后历史保持分离。本机合成 API 服务已停止，本轮服务统计为 0 请求，未冒充供应商验收。

公式点击显示 Copied，但 Browser API 剪贴板读回停留在工具自己的占位值，因此没有将自动读回计作成功。用户实际点击公式并 Ctrl+V 后确认“没问题”，该项记为人工验收。Code/Visual 切换、重新连接编辑器、浅色主题/16px 字号下布局均已实操；结束时恢复深色主题/12px、MathJax、Codex、On-demand、Queue，关闭公式点击复制与提示两个临时开关。未改默认项目设置。

截图证据另有 `artifacts/windows-ui-stop-preserved-0.12.17.jpg`、`windows-ui-deepseek-0.12.17.jpg`、`windows-ui-desktop-origin-0.12.17.jpg`。只读安装审计 `windows-installation-audit-0.12.17.json` 核对源码与安装副本、注册及工作区配置；它不替代真实推理或桌面项目归属检查。

## Codex 项目归属与剩余边界

用户报告聊天未进入 Codex 的 Overleaf 项目。已确认 Windows 首次安装说明遗漏 `--workspace`，当时 helper 工作目录为私有数据目录且没有配置项目 ID。重新执行安装并绑定 `<redacted-Codex-workspace>` 后，精确 backend project ID 为 `<synthetic-backend-project>`；安装说明与审计现已补充该检查，普通更新保留配置已有单元回归。

真实新建聊天 `<synthetic-conversation-B>` 的 cwd 与 backend projectId 均正确，但 Desktop 项目管理工具仍返回 projectId=null。这证明 backend 项目与 Desktop 侧栏项目归属不能等同。旧聊天的工具迁移被拒绝（无法安全确定来源项目），由用户手动移动；新聊天通过 Desktop 专用移动工具成功。随后工具读回两者均属于侧栏 Overleaf 项目 `<synthetic-sidebar-project>`。

只读检查当前 Desktop 包 `26.1103.3517.0` 表明：侧栏管理维护独立的 server-to-legacy 项目映射，自动采纳 backend thread.projectId 受 `localProjectTaskMembership` 控制；未读取或修改该功能开关的用户实值。对外 named pipe 的 owner/follower 白名单不提供项目归属方法。普通 local 项目也不使用 `metadata.codex.localProjectId` 建立映射，该字段用于 ChatGPT backing 的恢复，不能凭名称猜测写入。没有直接改 Codex 数据库、全局状态或私有 Electron bridge。因此，本轮可交付的是后台项目自动绑定，以及已明确归入桌面项目的现有两条交互测试聊天；后续新聊天的桌面侧栏自动归类仍是未解决限制，可能需要桌面 Move 操作。此前协议版本证据来自旧包，不能混称为同一版本全分支实测。

缓存最后页面退出后的自动回收已真实通过：三个页面减至一页后，pages=1、pins=0，persistent 与 temporary 均保留；关闭最后一页后，Chrome 正常后台触发清理。07:30:25 UTC 只读观察到 pages=0、pins=0，empty_since 已过 32.84 秒。temporary `<synthetic-temporary-snapshot>` 的元数据、manifest 及独占 main.tex blob 均消失；persistent `<synthetic-retained-snapshot>` 与镜像仍在，main.tex 350 bytes、chapter.tex 111 bytes 的哈希及镜像逐字节吻合，共享 chapter blob 未误删。没有直接调用 reconcile、GC 或手动删除文件来模拟通过。

用户执行时明确确认后，在真实页面点击 Confirm source cleanup，缓存变为 0 versions、0 bytes。只读核对确认该 scope 的 manifest、镜像文件和 blob 均清空（空父目录保留）；Codex 原会话 10 消息/5 轮、新会话 2 消息/1 轮，以及 DeepSeek 的 5 消息/3 轮全部保留，部分回答哈希不变。网页重新打开原会话仍显示 `DESKTOP_ORIGIN_OK`。随后 Sync project cache 实际重新上传当前两文件，恢复为 1 temporary、487 bytes、0 retained、1 page、0 protected operations。合成项目原文件和云端 PDF 保留，测试页已留给用户；没有清理其他项目。

本轮交互验收已结束，但不声称所有平台情形均被覆盖：完整关闭并重启 Chrome、BFCache 恢复和 Desktop writer 所有权交接全部协议分支没有执行真实操作；新会话自动进入 Desktop 侧栏项目仍存在上述外部接口限制。最后图片 `artifacts/windows-ui-final-0.12.17.jpg` 记录恢复后的缓存状态；设置弹窗随后已关闭，页面保留原会话。

扩展内部 API 设置页被 Browser Use URL 策略拒绝（仅允许 HTTP/HTTPS），没有绕过；用户负责填写该页。Chrome 扩展管理页也由用户手动重载。Windows Computer Use 技能禁止自动操作 ChatGPT/Codex 桌面 UI，因此 Desktop 显示以用户实际观察为准，不把只读 IPC 检查当成实时交互通过。
