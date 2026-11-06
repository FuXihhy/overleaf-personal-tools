# Windows 验收发现的通用修复：供 macOS 同步参考

本说明比较 v0.12.14（`0803251324c32a2f213f39a4ece7ddac264ab126`）与 Windows 开发分支截至 `ccde0be` 的实现。**发现问题的设备是 Windows，不代表问题只存在于 Windows。** 下表按触发条件和实际执行路径分类；“通用”表示代码不依赖 Windows 分支，不能代替在 macOS 上实际复现和复测。本轮没有执行 macOS 真实浏览器或桌面验收。

## 应同步的通用缺陷修复

| 问题与触发条件 | 修复后的行为 | 共享实现与主要回归 |
| --- | --- | --- |
| Chrome 完整项目同步被拒绝：把可信 `sender.documentId` 强制当成带连字符的 36 字符 UUID，而真实 Chromium 返回 32 位十六进制标识。 | 将浏览器提供的 documentId 当作有长度限制的不透明身份，与 tab ID 一起散列；继续校验扩展来源、顶层 frame、HTTPS 项目 URL、账号/项目范围。已有租约在更新和文档替换时保持兼容，绝不以网页 payload 或 tab URL 替代缺失的 sender 证据。 | [`src/codex/cache-lifecycle.ts`](../src/codex/cache-lifecycle.ts) 的 `verifiedDocument` / `acquire`；[`tests/codex-cache-lifecycle.test.ts`](../tests/codex-cache-lifecycle.test.ts) 的真实 Chrome 格式、旧身份迁移、导航及 BFCache 世代校验。此问题属于 Chromium 身份处理，不是 Windows API。 |
| 连接检查误报：只读登录信息和模型目录成功，就显示笼统的 Connected；用户关闭桌面窗口仍会看到成功，却无法由此判断项目读取或推理是否可用。 | 返回独立后台类型、项目 reader 检查结果和检查时间；实际检查 reader 的三个工具，但不创建聊天或发模型请求。界面显示“本机后台已检查”，把后台、项目同步、桌面窗口和推理验证分开。 | [`native/codex_host.py`](../native/codex_host.py) 的 `status` / `verify_project_reader`；[`src/codex/types.ts`](../src/codex/types.ts)、[`catalogue.ts`](../src/codex/catalogue.ts)、[`panel.ts`](../src/codex/panel.ts)；[`native/tests/test_connection_status.py`](../native/tests/test_connection_status.py)、[`tests/codex-catalogue.test.ts`](../tests/codex-catalogue.test.ts)、[`tests/codex-protocol.test.ts`](../tests/codex-protocol.test.ts)。 |
| 较早的成功检查或缓存模型目录覆盖较新的失败；关闭缓存错误提示后重新显示成功；页面注册失败被误归类为 helper 未安装。 | 手动检查真正重新查询，已在运行的旧查询结束后最多排入一次新检查；修订号阻止旧成功覆盖新失败。缓存受阻状态与后台状态独立，只有成功同步才解除；发送前失败明确报告问题未发送，并继续保留问题和引用，不提交或自动重发模型请求。 | [`src/codex/catalogue.ts`](../src/codex/catalogue.ts)、[`src/codex/panel.ts`](../src/codex/panel.ts)、[`src/content.ts`](../src/content.ts)；[`tests/codex-catalogue.test.ts`](../tests/codex-catalogue.test.ts)、[`tests/codex-panel.test.ts`](../tests/codex-panel.test.ts)、[`tests/codex-content.test.ts`](../tests/codex-content.test.ts)。 |
| Stop 后已经显示的回答在刷新/历史同步时消失：上游 interrupted turn 没有正式 agentMessage；较早完成的消息片段还可能遮住后续未完成片段。 | interrupted / inProgress 缺少正式答案时保留本地已接收内容；中断时按 item ID 合并完整片段与流式尾部。后来非空正式答案仍替换去重，completed 空答案仍清除旧稿；不能恢复修复前已经删除的文本。 | [`native/codex_host.py`](../native/codex_host.py) 的 `refresh_history` / `_ask`；[`native/tests/test_codex_history.py`](../native/tests/test_codex_history.py) 的 `test_stop_partial_survives_canonical_refresh_and_helper_restart`、`test_stop_keeps_unfinished_item_after_an_earlier_completed_item`；[`native/tests/test_codex_sync.py`](../native/tests/test_codex_sync.py) 的正式答案替换及 completed 空答案回归。 |
| Desktop owner 的活动/中断快照临时没有文本，把 follower 已显示的部分回答覆盖为空。 | 空的 inProgress / interrupted 快照使用最后已接收文本；正式完成/失败仍按原有终态处理，不据此抢占写入权或重放请求。 | [`native/codex_host.py`](../native/codex_host.py) 的 `_ask_desktop`；[`native/tests/test_desktop_handoff.py`](../native/tests/test_desktop_handoff.py)。此合并逻辑位于共用 host，macOS socket 与 Windows pipe 都会使用。 |
| 公式预览切换后仍显示旧超时；迟到的 MathJax 草稿诊断覆盖已经成功的 TeX 编译结果，或误删较新的设置/索引状态。 | 错误带请求归属；新公式、上下文失效、引擎切换和成功结果只清除自己仍持有的旧错误。真实 TeX 结果优先于迟到草稿，并保留其他操作发布的新状态。 | [`src/content.ts`](../src/content.ts) 的 `publishPreviewStatus` / `clearPreviewStatus` / `renderDraft` / TeX 完成分支；[`tests/content-preview.test.ts`](../tests/content-preview.test.ts) 中 cloud→local、迟到失败、较新状态和 MathJax 草稿等 6 项新增回归。 |

前 3 项主要来自 `47d4b32`，后 3 项来自 `ccde0be`。连接状态新增字段的协议解析、native 返回值、前端状态和 UI 文案必须一起迁移；只改“Connected”字样不能解决状态竞态和项目同步受阻问题。

## 共享新增能力与 Windows 专用实现

`97f323f` 同时包含 Windows 移植和三种项目上下文模式。普通、按需、本地保留模式属于**共享新增能力**，不是仅 Windows 生效的补丁。它依赖浏览器页面租约、队列/活动请求保护、native 持久元数据与同锁清理：见 [`src/codex/cache-lifecycle.ts`](../src/codex/cache-lifecycle.ts)、[`native/cache_lifecycle.py`](../native/cache_lifecycle.py)、[`native/project_context.py`](../native/project_context.py)、[`src/content.ts`](../src/content.ts) 和设置/协议文件。迁移时应连同 [`tests/codex-cache-lifecycle.test.ts`](../tests/codex-cache-lifecycle.test.ts)、[`native/tests/test_cache_lifecycle.py`](../native/tests/test_cache_lifecycle.py)、[`native/tests/test_cache_runtime.py`](../native/tests/test_cache_runtime.py) 成套同步；不能只复制下拉框或最后页面关闭后的删除逻辑。

共用 [`native/manuscript_mcp.py`](../native/manuscript_mcp.py) 另将 JSONL 输出明确编码为 UTF-8，避免依赖管道的系统文本编码。这是由 Windows 编码问题促成的协议健壮性修正，macOS 可参考；不要因此把 Windows 存储路径或启动器复制到 macOS。

| Windows 专用或平台适配 | macOS 同步要求 |
| --- | --- |
| [`native/windows_tex.py`](../native/windows_tex.py)：AppContainer、Job Object、capability ACL、Windows TeX 路径/字体缓存与 LuaLaTeX 参数。 | 保留 macOS 现有沙盒和编译参数；不能用 Windows 权限配置、`--safer` 差异或资源时限直接覆盖 macOS 行为。 |
| [`native/windows_desktop.py`](../native/windows_desktop.py)、[`native/desktop_ipc.py`](../native/desktop_ipc.py) 的 Windows named pipe 分支、SID/session/package/process 校验。 | 保留 macOS socket 的归属、权限和 peer 校验。共享 follower 的中断文本修复应迁移，传输适配不混用。 |
| [`native/platform_utils.py`](../native/platform_utils.py)、[`native/native_setup.py`](../native/native_setup.py)、安装器中的 HKCU 注册、`.cmd` 启动器、MSIX 路径规避、Windows ACL/reparse/长路径处理。 | 共用 native 文件现在导入平台适配模块，安装清单必须带上依赖；在 macOS 确认 POSIX ownership / chmod / flock / 原子发布行为仍走原有语义。 |
| 原始文件描述符添加 `O_BINARY`，Windows 用不覆盖目标的 rename 发布不可变快照。 | `getattr(os, 'O_BINARY', 0)` 在 POSIX 为零；macOS 仍走原子 hard-link 发布路径，不能无条件替换。 |
| [`native/api_provider.py`](../native/api_provider.py) 的 `_interruptible_response`。 | 仅 `os.name == 'nt'` 且实际 socket 时启用，修复 Winsock 下取消后读取仍阻塞的问题。不要把这段 Windows reader 强制用于 macOS；共享 API 取消回归仍应执行。 |

## 安装与项目归属：不要误写为通用代码缺陷已修复

Windows 首次安装说明漏写 `--workspace`，导致 helper 没有配置 Codex 工作目录。说明和安装审计已补齐，安装器原有“更新保留 workspace.json”逻辑已有回归。**修复首次安装命令，不等于保证 Desktop 侧栏分类。** 本轮真实新聊天的 `cwd` 与 app-server backend `projectId` 均正确，但 Desktop 侧栏归属仍为空，现有测试聊天通过桌面 Move 或专用项目管理工具完成归类。

当前检查到的 Desktop 包维护独立的后台项目到侧栏项目映射；未发现 native follower 接口可执行侧栏归类。尚未确定相同限制是否影响当前 macOS Desktop。macOS 验收应分别记录后台绑定与桌面侧栏结果，不直接改 Codex 数据库或全局状态来制造通过，也不要把“Open in Codex 能打开聊天”当成“聊天已经归入指定项目”。详见[真实交互记录](windows-connection-acceptance.md)。

## macOS 最小回归建议

先运行完整共用测试，确认 macOS 的原生沙盒测试实际执行；跳过数应单独列出，不计入通过。当前记录中的前端 971 项、原生 406 通过/15 跳过均来自 Windows，不能复用为 macOS 结果。

```sh
pnpm install --frozen-lockfile
pnpm check
python3 -m unittest discover -s native/tests -v
```

然后只用[安装验收指南](../acceptance/README.md)中的合成项目完成以下关键交互。正常关闭桌面窗口后检查后台，确认文案只说明后台检查，并实际完成一次跨文件问答；用真实 Chrome 同步两个源码文件，确认页面身份不被拒绝。开始较长回答，等收到内容后停止并刷新，确认文本仍在，再正常完成一个回答以检查去重。切换本机/云端预览或从一次失败恢复，确认旧预览错误消失且不覆盖新的设置状态。最后在同一聊天双向续聊，分别记录历史回流、实时输出和项目归属，未观察到的项目记为未验证。

若同步三种缓存模式，再加一组缓存验收：同项目两页时关闭一页，临时版本继续存在；最后一页关闭并经过宽限期后，仅临时版本自动清理，保留版本与历史仍在。显式清理必须只使用确认可删除的合成测试缓存，随后重新同步当前源码。浏览器重启、BFCache 恢复和 Desktop owner 交接的特殊分支应另记覆盖范围，不能用普通刷新代替。

## 合并和证据边界

`97f323f` 是平台移植与缓存能力混合提交；`47d4b32` 依赖其中的缓存协议；`ccde0be` 除通用修复还含 Windows 文档、审计脚本和开发版本标记。因此不建议把这些提交无审查地当成 macOS 发布提交 cherry-pick。若 macOS 分支已有等价缓存能力，可按上面的文件和函数迁移通用修复及测试；否则先合入完整依赖，再保留目标分支自己的安装路径、沙盒、manifest/version_name 和发布版本策略。

提交中的验收文档是可追溯的历史证据，不是新安装者的通过报告。原始截图、日志、私有工作区配置、API 配置、数据库和项目缓存继续保留在忽略目录，不应整批随 PR 上传。本次另在 `acceptance/evidence/2026-11-06/` 纳入经逐张检查的三张合成项目截图；它们不含 API key 或用户原稿，与原始私人截图的保留规则不同。历史记录中的本机路径、合成项目/会话 ID 只用于定位当次证据；若将私有仓库改为公开发布，应先去除不必要的机器标识。本次对截至 `ccde0be` 的 212 个 tracked 文件进行了文件清单与常见 provider-key/private-key 形状检查，未发现这些秘密形状；这不是完整安全审计或所有秘密格式均不存在的证明。
