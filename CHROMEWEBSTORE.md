# Chrome Web Store Listing — Overleaf Personal Tools

> Last Updated: 2026-11-01
> Draft only. No store submission or publication has been performed. This file records proposed listing copy and current data flows; publisher details and public assets remain to be supplied.

## Store Listing

**Extension Name:** Overleaf Personal Tools

**Short Description:** Overleaf 中的项目命令补全、Code 与 Visual 公式预览，以及结合选区和项目上下文的 Codex 问答。

**Detailed Description — proposed Chinese copy**

在 Overleaf 中补全项目自定义命令、预览正在编辑的公式，并围绕文稿选区提问。

读取项目中的宏包声明和自定义定义文件，为支持的命令添加补全。可以选择额外宏文件，默认查找 macros.sty；也可以控制预览加载的来源及顺序。

在 Code 或 LaTeX Visual 模式编辑公式时显示预览。即时预览保留可识别的数学内容，并将尚未完成或不支持的部分标红。需要真实 TeX 排版时，可选择 Overleaf 云端或已配置的本机 TeX；云端使用同一账号的共享预览项目，保留必要的临时编译文件。不同引擎的命令和字体支持可能不同。

可选的 Codex Assistant 支持文稿选区引用、回答片段引用追问、项目上下文问答、对话历史、左右面板位置和 LaTeX 复制。选中单条回答中的文字后，可点击“引用所选内容”添加到下一条问题，公式保留 LaTeX，引用可展开或移除；添加引用不会自动发送。它需要另行安装配套 macOS 连接程序。默认沿用本机 Codex 登录和配置；也可在扩展独立设置页添加自己的 DeepSeek 或其他兼容 OpenAI Chat Completions 的 API，并按项目选择。发送问题时，所选内容会交给当前选择的服务处理，按该服务的用量规则计费。本机连接不表示模型离线运行。回答不会自动改写文稿。API 对话保存在这台 Mac，不会同步到 Codex 桌面。回复过程中可把追加问题排队，连接支持时也可立即补充当前回复；刷新后队列等待用户继续。选中文字包含公式时，公式也显示选中状态。可单独开启默认关闭的公式复制小提示。新发往 Codex 的问题保持简洁，选区与项目资料仍用于回答；同步回来时，能识别的回答引用单独显示，较长问题可展开阅读全文。

发送区显示当前连接状态；临时连接问题会尝试自动恢复，也可点击状态重新检查。重连保留草稿，不会自动重复发送问题。

Codex Assistant 设置修改后自动保存，也可将常用配置设为默认，供同账号中尚未单独配置的项目使用；项目补充要求和已有项目设置保持独立。

安装后刷新 Overleaf 项目页，从原有 Settings → Extension 打开 Preview 或 Codex Assistant 设置。选项跟随 Overleaf 的中英文界面。目前仅支持 www.overleaf.com 和 cn.overleaf.com 的项目页面，需要 Chrome 145 或更新版本。

项目读取用于补全、预览或用户主动发送的问答。设置和显示历史保存在当前浏览器配置及配套本机程序中；云端编译文本保存在用户的 Overleaf 预览项目，Codex 按其正常会话机制保存问答及提供的上下文，自备 API 接收所选上下文并遵循该服务的保留规则。用户主动填写的 API key 仅在扩展设置页输入，并由本机连接程序保存；不写入 Overleaf 页面或浏览器存储。扩展不发送使用遥测，也不读取账号密码。

Support: pending public contact details; replace this line before submission.

**Category:** Productivity (proposed)

**Single Purpose:** Assist writing and understanding LaTeX manuscripts within Overleaf through project-aware completion, formula previews and manuscript Q&A.

**Primary Language:** Chinese (Simplified), proposed; English UI is also supported.

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
| --- | --- | --- | --- |
| Store icon | 128×128 PNG | Pending original/publicly distributable icon | Not supplied; manifest currently omits icons |
| Screenshot 1 | 1280×800 or 640×400 | Pending release screenshot | Code and Visual formula editing with artificial text |
| Screenshot 2 | 1280×800 or 640×400 | Pending release screenshot | Preview sources and native settings |
| Screenshot 3 | 1280×800 or 640×400 | Pending release screenshot | Codex question, selection and history using artificial text |
| Small promo tile | 440×280 | Optional; not created | — |
| Marquee promo tile | 1400×560 | Optional; not created | — |

Existing `docs/screenshots/` images are development/acceptance evidence, not approved store assets. Refresh screenshots for the 0.12.4 autosave settings and Check connection / Set as default actions, plus the recovery rail, selection dismissal and Visual custom-macro update; remove private manuscript or conversation content. The UI currently includes `assets/zero-two-avatar.png` (512×512) and `assets/codex-app.png` (1024×1024); public redistribution rights or replacement artwork remain unresolved. Neither is declared as a store icon.

## Permissions Justification

| Permission or match | Type | Justification |
| --- | --- | --- |
| `storage` | permissions | Remember project preview settings, source choices/order, cloud workspace bindings and synchronization metadata, plus assistant preferences, a bounded display history and explicitly queued questions with their captured context so users can return to their manuscript workflow. |
| `nativeMessaging` | permissions | Connect the optional local TeX compiler and assistant to separately installed, dedicated helpers; the assistant helper uses either local Codex or an explicitly configured API endpoint. The helpers return formula output or the user's requested manuscript discussion; cloud and instant preview do not require the helpers. |
| `https://www.overleaf.com/project/*` | content_scripts.matches | Read the current project's editor content and relevant source files to provide command completion, formula previews and explicitly requested manuscript Q&A within the English Overleaf site. |
| `https://cn.overleaf.com/project/*` | content_scripts.matches | Provide the same manuscript features within the Chinese Overleaf site. |

The manifest has no `host_permissions`, `tabs`, `history`, `cookies`, clipboard, or all-sites permission. Packaged rendering resources and the two UI images are exposed only to the two Overleaf origins. Version 0.11.2 adds no Chrome permission or match pattern. API calls originate in the installed native helper; the extension-owned options page handles credentials through a separately validated native port. The default Codex route retains the 0.9.4 Desktop adapter. The existing local helper can route a submitted question to the same conversation already held by Codex Desktop over its private, same-user socket; it validates the owner and protocol and never opens a network listener. Quoting an answer reads the user's selection within the extension's own transcript and does not access the system clipboard.

## Privacy & Data Use

### Data Collection

**Does the extension handle user data? Yes.** It processes manuscript content and optional questions; it must not be described as keeping all data exclusively on the device. The following is a draft disclosure inventory, to reconcile with the current dashboard form before submission.

| Data type | Handled / stored | Off-device use | Purpose / recipient |
| --- | --- | --- | --- |
| Website content | Project text, current formula, selected source, file paths and source positions; preview snapshots remain in page memory, while explicitly queued questions retain bounded captured project context locally | Chosen cloud mode writes the formula, preamble and required text dependencies to the user's Overleaf preview project; sending an assistant question supplies the selected/bounded context to the configured Codex service or user-selected API endpoint | Command completion, rendering and manuscript discussion |
| Personal communications | User questions, answers, quoted manuscript selections and explicitly selected answer excerpts are retained as assistant history; unsent queued questions and their snapshots are separately stored locally | Sent through the chosen Codex configuration or API connection when asking or advancing an explicitly created queue; after reload the queue waits for explicit resume. Selecting or attaching an answer excerpt does not send a model request. Codex retains its normal conversation records; API recipients follow their own retention policies | Show and continue the user's registered project conversations |
| Account/project identifiers | Overleaf-provided account ID and project ID, bindings, file identities/hashes and queue deadlines | Overleaf uses its existing account/project identifiers for requests; local history is partitioned by account/project and, for API mode, connection profile | Keep workspace settings and histories separated; no email used as identifier |
| Authentication information | Existing Overleaf session and transient page CSRF token; optional user-entered API key saved only by the native helper in a private local file (directory 0700/file 0600, not Keychain) | Overleaf credentials stay on the current origin; Codex handles its own login; a saved API key authenticates only the configured endpoint, without redirects | Authorized project reads, cloud compilation or explicitly selected API questions; no account-password collection or copied Codex credentials |
| User activity/preferences | Active source selection and project options; no analytics log | Selection/context only as part of the chosen feature above | Trigger previews, remember preferences and attach requested context |
| Web history, location | Not independently collected | None | No browsing-history or location feature |
| Health/financial information | Not specifically requested or classified; could occur in user-supplied manuscript/question content | Follows the chosen content flow above if the user supplies it | No separate health, finance, advertising or profiling feature |

No telemetry/advertising endpoint was identified in the extension. There is no extension-publisher backend. The service recipients are Overleaf for requested project operations and either the service used by the user's Codex configuration or the explicitly selected API endpoint for requested Q&A. The optional connection check requests only `/models`, with no question or manuscript; an empty response list does not validate the configured model. Questions use `/chat/completions`, with no automatic fallback or replay.

### Storage, retention and controls

Preview source snapshots and rendered caches remain in page memory. Chrome local storage retains preferences, account/workspace bindings, file metadata/hashes and coordination state; it does not persist preview-only formula text or PDFs. Cloud preview files remain in the shared Overleaf project, and deleting a file does not promise removal from Overleaf history.

Assistant display history is saved in Chrome local storage with a 60-message/350000-character budget including both manuscript and answer quotes. The separate native helper retains registered conversations and both quotation types in local history databases. Codex retains its own normal conversation and supplied context. API profiles have separate account/project histories containing messages, quotations and context for continuation; these are not imported or synchronized into Codex Desktop. The bounded browser display caches are also separated by profile. New chat, deleting an API connection and helper uninstall do not erase those histories. Deleting a connection removes its locally saved key; helper uninstall retains saved connections. The credential file is permission-restricted local JSON, not application-encrypted or stored in macOS Keychain. A changed API destination requires a new connection and cannot inherit the previous connection's history. Clearing browser extension data, removing the dedicated cloud project and managing native/Codex histories are separate actions; there is currently no unified erase-all control. Settings are not synchronized through Chrome Sync.

The follow-up queue separately stores up to eight captured questions within a
1 MiB JSON budget in Chrome local storage, scoped to the Overleaf account/project
and fenced by the selected provider and conversation. Each item includes its
question, quotations, bounded project-file text and settings as they existed
when queued. Queue items are removed after completion or explicit removal. A
reload restores the queue paused; a potentially accepted submission is marked
for review and never automatically replayed. Explicitly editing an item returns
its text and quotations to the composer without replacing an existing draft.
An unknown Overleaf account uses page-memory queue state only. This queue is not
Chrome Sync, a cloud storage feature or an unattended background runner.
Formula selection paint and the optional copy notice do not add a data recipient
or alter copied contents. The two copying preferences are independent and off by
default.

Compact message display does not reduce the source context supplied for
inference. New Codex questions and steering messages keep their visible text
separate from the bounded, untrusted manuscript context sent to the same
selected service. Incoming known annotation envelopes become a question plus
an expandable quotation in Overleaf; unknown formats remain available as full
text behind the ordinary long-message expansion control. This display treatment
does not delete or rewrite original Codex conversation records, change API
recipients or retroactively alter older Desktop messages.

### Data Use Certification — publisher confirmation pending

The inspected implementation contains no data sale, unrelated advertising use, or creditworthiness/lending use. The publisher must confirm the corresponding dashboard certifications and final service disclosures before submission; this draft does not submit or attest on their behalf.

## Privacy Policy

**Privacy Policy URL:** Pending. Prepare and publish a policy consistent with the data inventory, retention and recipients above, including public privacy contact details and current service-policy links. This document is an internal preparation record, not a published privacy policy.

## Distribution

**Visibility:** Pending publisher choice (Public / Unlisted / Private).

**Regions:** Pending publisher choice.

## Developer Info

**Publisher Name:** Pending.

**Contact Email:** Pending; do not infer a public address from local account configuration.

**Support URL / Email:** Pending.

**Homepage URL:** Pending.

## Version History

No Chrome Web Store submission is recorded here. Earlier local releases are described in `CHANGELOG.md`.

| Version | Date | Changes | Status |
| --- | --- | --- | --- |
| 0.12.8 | 2026-11-02 | Keep Reload commands and packages visible beside the collapsed support disclosure, with a stacked layout in narrow panels. Browser-only update; no new permissions. | Draft |
| 0.12.7 | 2026-11-02 | Rename the tab to LaTeX Preview, autosave its settings, simplify Set as defaults, and move command/package reload into support details with usage guidance. Avoid full project analysis for display-only changes. Add quiet Codex composer guidance to manual cache sync after source errors or observed edits plus five minutes since successful sync. Browser-only update; no new permissions. | Draft |
| 0.12.6 | 2026-11-02 | Reuse verified scoped content blobs and upload only changed project sources; add manual project-cache sync and bounded page-side integrity recovery. ZIP export remains full. Reader update requires Desktop restart. No new permissions; automatic source cleanup remains unimplemented. | Draft |
| 0.12.5 | 2026-11-01 | Treat same-project tab contention as pending history sync, preserve cached chats and drafts, and recover automatically when the writer finishes. Keep account/project isolation and write protection. Browser and native host update; no new permissions. | Draft |
| 0.12.4 | 2026-11-01 | Autosave Codex Assistant preferences and replace Save settings with Set as default. Remove the duplicate new-chat action from settings. Defaults stay account-scoped and exclude project instructions and chats. Browser-only update. | Draft |
| 0.12.3 | 2026-11-01 | Disable and mute the copied-formula notice setting when click-to-copy is off, preserving its preference for re-enabling. Browser-only update. | Draft |
| 0.12.2 | 2026-11-01 | Add compact connection status, bounded recovery for temporary account routing failures, and model catalogue restoration. No new permissions. | Draft |
| 0.11.2 | 2026-11-01 | Fix Codex context admission names and rejected-send history; make queue/steer a saved preference with per-entry promotion; repair Visual macro lifecycle and typing updates. Update native helper; no new permissions. | Draft |
| 0.11.1 | 2026-10-31 | Refine the update refresh icon and tooltip, clear manuscript quotations on intentional Code/Visual deselection, and supplement idle Visual formulas with project macro definitions while preserving native editing. Browser-only update; no new permissions. | Draft |
| 0.11.0 | 2026-10-31 | Show selected formulas, add an opt-in copied-formula notice and captured-context follow-up queue with paused reload recovery. Offer steering on supported independent Codex and connected Desktop conversations; API remains queue-only. Refresh local-login connections and distinguish missing Desktop ownership from login failure. Keep new Codex message bubbles compact while retaining separate model context; show recognized Desktop annotations as expandable quotations. No new Chrome permissions. New browser acceptance remains pending. | Draft |
| 0.10.0 | 2026-10-31 | Keep Codex as default; add optional DeepSeek/OpenAI-compatible API profiles, extension-owned credential management and distinct local API histories. Update the separate native helper; no new Chrome permissions. Automated synthetic validation passed; browser/live API verification remains pending. | Draft |
| 0.9.4 | 2026-10-31 | Continue the same Desktop-owned conversation directly from Overleaf, with streamed replies and precise stop controls; no idle-lock release or restart required on the verified Desktop version. Update the separate local helper. | Draft |
| 0.9.3 | 2026-10-31 | Explicitly quote selected assistant-answer text in a follow-up, preserving LaTeX and both quote types in history. Update the separate Codex helper; no new permissions. Validation is recorded separately in the release evidence. | Draft |
| 0.9.2 | 2026-10-31 | Add LaTeX Visual editing to the formula-preview update path; retain existing preview settings and permissions. Validation is recorded separately in the release evidence. | Draft |

## Review Notes

Public-release preparation remains incomplete: publisher/contact information, privacy-policy hosting, distributable artwork, sanitized screenshots and final listing review are pending. The extension integrates with Overleaf internals, so editor changes can affect compatibility. It is an independent tool; any public listing must avoid implying endorsement by Overleaf or OpenAI.

Instant preview does not execute arbitrary TeX. Cloud preview uses account compilation resources and currently synchronizes text dependencies only. Local TeX and either assistant source require separately installed macOS helpers; a store install alone will not install them. Store extension identity must be reflected in the helpers' exact allowed-origin registrations. The API path has automated synthetic coverage only. Browser-tool access was disabled during the 0.11.0 work. In 0.11.1, local Chrome acceptance covered the refresh notice, Code/Visual quote dismissal and unclicked custom-macro rendering. The new release still awaits activation and acceptance on a real Overleaf page; the broader 0.11.0 queue/API matrix remains pending. No live external API inference is claimed. The local browser-use permission of the development assistant is distinct from this extension’s own permissions.

**Rejection History:** None recorded; no submission made.

- 0.12.9 (2026-11-02): API project model selection, authenticated model discovery, editor identity retry and fresh saved-project fallback with notice. Browser/native update; no new permissions or data destinations.

- 0.12.10 (2026-11-02): Place Model immediately below Model source; existing native controls and autosave retained. Browser layout only; native remains 0.12.9; no permission changes.

- Native 0.12.11 (2026-11-02), browser 0.12.10: bounded long-manuscript API review, duplicate-read detection, explicit partial review at resource limits. No new browser permissions or data destinations.
- 0.12.12 (2026-11-02): configurable API project reading rounds, tool calls and time budget, with automatic saving, input validation and an explicit API usage/cost notice. Browser and native helper update together; no new permissions or data destinations.
- 0.12.13 (2026-11-02): dismiss the current project-cache notice without disabling future notices. Reading position and drafts are preserved. Browser only; native remains 0.12.12; no permission or data-destination changes.
