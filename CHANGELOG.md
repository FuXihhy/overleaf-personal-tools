# Changelog

## 0.12.14 — 2026-11-02

- LaTeX Preview 的项目支持区域新增绿色 Reconnect editor／重新连接编辑器按钮，折叠详情时也可使用。沿用原生按钮样式；连接中与确认结果在预留的灰色状态行显示，不再产生布局跳动。无需二次确认，不受项目索引忙碌影响。
- 重连通过 Overleaf 的第三方扩展接口恢复接入，并检查当前编辑器的活跃插件及初始化结果；旧 ready 事件不作为成功依据。并发点击合并，失败有超时提示，文稿、光标和撤销记录保留。
- 回到编辑器、页面重新可见或编辑器节点更换时，轻量检查后仅对失联接入进行恢复；合并事件并限频，不在每次输入时重连。扩展上下文失效后完整停止。补齐同一编辑器更换整个状态后命令补全与按键配置恢复的遗漏。
- 仅浏览器更新，本机连接仍为 0.12.12，无新增权限。扩展更新后的旧项目页仍需刷新。

## 0.12.13 — 2026-11-02

- 项目缓存提示右侧新增小型关闭按钮，只关闭当前这次提示。相同状态不会因流式更新、语言切换或面板重新打开而反复出现；问题解除后再次发生或提示类型变化时重新显示。关闭状态不写入设置，刷新页面后重置。
- 关闭时保留阅读位置、草稿和引用；按钮提供中英文悬停提示与键盘操作，沿用原有图标和配色。仅浏览器更新，本机连接仍为 0.12.12，无新增权限。

## 0.12.12 — 2026-11-02

- API 的当前项目上下文设置新增可调整的阅读预算：读取轮次 1–256（默认 64）、工具调用次数 1–512（默认 128）、总时限 90–580 秒（默认 580）。明确说明提高上限可能增加 API 请求、Token 用量、费用和等待时间。
- 原生样式数字输入框在离开后自动保存，非法数值显示就地提示且不覆盖已有设置。只影响后续发送的消息；已排队和正在回复的消息保留原预算。Codex 来源与仅选区模式不显示这组项目读取设置。
- 浏览器协议、本机入口和 API 读取器共同校验预算；达到上限时仍保留独立最终回答机会和 60 秒答复时间，尝试给出注明已读范围的阶段性答复。浏览器与本机连接均更新至 0.12.12，无新增权限。

## 本机连接 0.12.11 — 2026-11-02

- 修复 API 通读长文时达到固定 16 轮后直接失败的问题：读取预算改为最多 64 轮、128 次调用，另保留最终回答机会。提示优先使用较大分页并并行读取独立文件。
- 重复读取规范化去重；连续三轮没有新增读取时收束。达到轮数、调用量、上下文或时间边界时，保留已交付正文，明确说明覆盖不完整并尝试输出阶段性意见，不静默截断源码。
- 总时限仍为 580 秒，为最后回答预留 60 秒；仅本机控制的读取超时进入收束，不重试认证／网络故障，不重发用户问题。
- 浏览器仍为 0.12.10，本机连接更新至 0.12.11。刷新项目页即可建立新连接，无需重新加载扩展或重启 Codex。

## 0.12.10 — 2026-11-02

- API 设置说明明确：DeepSeek 等 API 聊天记录由本扩展保存在本机，不同步到 DeepSeek、Codex 等客户端；中英文同步更新。

- 将 Model 移至 Model source 下方，自定义模型 ID 与推理强度紧随模型；沿用原生字体、控件和自动保存。仅浏览器布局更新，本机连接保持 0.12.9。

## 0.12.9 — 2026-11-02

- 修复 API 模式隐藏模型选择且始终使用连接默认模型的问题。项目设置从服务商读取可用模型，保留连接默认和手动模型 ID；选择后自动保存，独立于 Codex 模型偏好。认证／网络失败不再仅凭已配置连接显示已连接。
- 修复切换缓存编辑器后延迟提问无法确认源码身份的问题；短暂加载时自动重试。仍无法确认实时缓冲区时使用新下载的完整 Overleaf 源码，明确提示尚未保存的编辑未确认，不将旧文件内容写入新文件。下载失败仍阻止发送。
- 浏览器与本机 API 连接更新至 0.12.9，无新增权限。

## 0.12.8 — 2026-11-02

- 将 Reload commands and packages／重新读取命令与宏包移到项目支持详情右侧，折叠时也可直接操作。窄窗口自动放到下一行，展开内容保持完整宽度，沿用原生字号和按钮样式。浏览器更新，无新增权限。

## 0.12.7 — 2026-11-02

- Codex 对话框新增独立的轻量缓存提示，明确引导到 Settings → Extension → Codex Assistant → Sync project cache。源码捕获、读取或恢复失败时提示，不被思考或回复结束状态覆盖；成功同步后清除，不弹窗或重复刷新相同提示。
- 当前页面在成功同步后检测到正文差异，且距该次同步至少五分钟时，提示缓存可能未更新。缓存单纯变旧、首次打开相同内容和首次同步前编辑不误报；恢复原文或成功同步后清除对应提醒，同步期间继续输入的变化仍保留。只保存指纹，不额外保存全文。
- Extension 下的 Preview 更名为 LaTeX Preview／LaTeX 预览，随 Overleaf 语言切换。
- LaTeX Preview 设置修改后自动保存，移除 Save settings；连续修改串行写入，文件名输入短暂停顿后保存，离开输入框或关闭设置时提交。失败保留草稿并提供重试，不重建正在操作的表单。
- Set as global defaults 简化为 Set as defaults／设为默认，说明默认配置用于当前浏览器中尚未单独设置的项目，已有设置不被覆盖。
- Refresh project files 移入项目支持详情，改为 Reload commands and packages／重新读取命令与宏包，并解释新增、重命名或未打开文件更新后需要手动读取的情况。
- 仅入口及额外定义文件配置重新分析索引；补全开关、引擎与预览来源调整不重新读取项目，补全开关也不中断公式渲染。浏览器更新，本机连接仍为 0.12.6，无新增权限。

## 0.12.6 — 2026-11-02

- 完整项目每次以最新源码导出建立清单，再按文件 SHA-256 与长度校验本机缓存。仅上传缺失／变化的文件；本机按账号和项目隔离复用正文块，新快照只保存清单。未改文件不重复写入，删除和重命名准确反映到新快照，旧对话仍引用原版本。Overleaf ZIP 下载仍为完整导出，并非服务器端增量下载。
- Codex Assistant 设置新增原生样式的 Sync project cache／同步项目缓存按钮，显示文件总数与上传数量；不发送问题、不重开对话、不修改设置。
- 完整项目问题发送前验证快照；页面仍打开的回复期间每五秒检查，确认为缓存缺失或损坏时重新导出并增量同步，再验证原快照。每条快照监测最多两次修复尝试，不自动重发问题。原版本无法恢复时明确提示，不能用新正文替换旧快照。
- 兼容读取既有快照；更新本机读取器后要求 Codex 桌面重启一次，避免已运行的旧读取器误读新格式。浏览器与本机连接均更新至 0.12.6，无新增权限。
- 三种保留模式及“最后一个项目页面退出且所有消息结束后清理”的占用机制仍为设计，尚未开启退出自动删除。已发布的旧源码与聊天记录不清理。

## 0.12.5 — 2026-11-01

- 修复同一项目多个页面共用聊天时的误报：一个页面回复期间，另一个页面读取历史改为返回本项目缓存，并显示轻量等待提示；释放占用后按现有轮询自动恢复，不再要求重新连接或新建对话。
- 等待期间保留各页面的当前对话、已有消息、引用与草稿；空缓存也会继续轮询。真实同步故障显示自动重试提示。未确认同步状态前仍禁用发送，不自动重发问题。
- 保留账号／项目隔离、会话归属验证和写操作互斥；不同项目可独立读取。浏览器扩展与本机连接均更新至 0.12.5，无新增权限。

## 0.12.4 — 2026-11-01

- Codex Assistant 设置修改后自动保存；补充要求在输入停顿、离开输入框或关闭设置时写入。连续修改串行保存，失败保留草稿并显示错误。模型与补充要求修改只影响后续请求，不重新连接或中断正在进行的回复。
- 原 Save settings 改为 Set as default。默认配置按 Overleaf 账号保存在当前浏览器，仅供没有项目专属值的设置继承；项目补充要求、对话和密钥不复制，已有项目值优先。
- 移除设置里的 Start new conversation，聊天栏的新建对话入口保留。
- Check connection 放在左侧并使用绿色主按钮，Set as default 放右侧并使用次要按钮样式。
- 切换模型来源或启停助手期间保留连接占用，防止自动保存与新发送冲突。沿用 Overleaf 字体和控件样式。浏览器更新，本机连接仍为 0.12.2，无新增权限。

## 0.12.3 — 2026-11-01

- 关闭“单击公式复制 LaTeX”时，“显示公式复制提示”整行标灰且不可操作；重新开启后恢复原有提示偏好。保存期间及失败回退也保持依赖状态一致。浏览器更新，本机连接仍为 0.12.2，无新增权限。

## 0.12.2 — 2026-11-01

- 发送左侧新增轻量连接状态，区分连接中、重连中、已连接、需登录及连接中断；沿用 Overleaf 字体、颜色及浮窗，长错误放入详情。点击状态可重新检查，保留草稿与引用。
- 账号路由发现超时和临时断连自动有界恢复；本机检查共用 36 秒预算并最多重建一次，页面再按 5／15 秒最多检查两次。后台页、正在回复和历史读取期间延后；关闭或切换来源取消旧状态。不会自动重发问题或引导消息，也不会无限循环。
- 临时错误使用简短提示，模型目录成功后自动恢复；登录失败清除旧目录，Astra 及其推理强度来自当前账号实际返回值，不硬编码可用性。
- 浏览器扩展和本机连接均为 0.12.2，无新增权限。

## 本机连接 0.12.1 — 2026-11-01

- 浏览器扩展保持 0.12.0，无需再次重新加载扩展。发送及引导时通过固定 application 上下文传入当前阅读指令，修复旧聊天仍受“无需使用工具”约束的问题；正文、选区、回答引用继续保持 untrusted。独立连接明确保留续聊的模型及推理强度。
- 相同账号／项目、主文件及源码内容复用不可变快照；修复每次提问都保存同一份正文的问题。下一次上传时清理超过 24 小时未活动的未完成上传。已发布历史版本保留，不同修订仍可能增加磁盘占用。
- 本机测试 268 项通过；实际运行时的合成传输测试验证固定应用指令完整进入 developer 消息，正文仍为外部材料。三种上下文／保存模式是新增设计，尚未加入当前设置；当前版本不在退出项目时自动删除已发布快照。

## 0.12.0 — 2026-11-01

- 修复 Codex 运行时将单条附加上下文硬截为 4,000 UTF-8 字节的问题：引用数据按独立 JSON 分片，每片不超过 3,600 字节，附完整性摘要与序号。
- 项目模式改为同步完整文本快照，再由本机只读 `overleaf_project` MCP 提供文件目录、全文搜索和按行读取。取消旧的 64 文件、单文件 80,000 字符摘录策略；新的完整性边界为 2,000 个文本源文件、单文件 2 MiB、总计 16 MiB，超限或上传不完整会明确失败，不以节选继续提问。
- 每次捕获重新导出项目，并覆盖当前编辑器的实时内容；排队与引导保存不可变的项目版本。浏览器队列只存快照引用，全文保存在本机专用私有目录。旧队列中只有节选的条目需取回编辑后重新捕获。
- API 来源使用相同的只读检索工具循环；服务商不支持工具调用时明确报错，不悄悄删掉上下文。
- 保留 0.11.4 的引用位置跳转修复。升级需要同时更新扩展和本机连接；安装器注册唯一的本地只读 MCP，已开启的 Codex 桌面可能需要重启一次载入新连接。


## 0.11.4 — 2026-11-01

- 修复实页验收发现的缓存标签定位超时：目标文件已经打开时，Overleaf 恢复缓存编辑器，不一定触发正文变化／新建通知。现在在切换前记录编辑器与正文对象，确认已切到目标内容后定位；不再等待必然缺失的加载通知。
- 保留旧正文保护：只有标签名称变了、旧编辑器内容尚未替换时继续等待，不会把相同文字误认成目标文件。
- 仅更新浏览器扩展，本机 Codex 连接仍为 0.11.2，无新增权限。
- 验证：735 项前端测试、TypeScript、构建通过；Chrome 中以两个真实缓存编辑器做四次往返，Code／Visual 均定位成功，正文修改次数为零，草稿保留。

## 0.11.3 — 2026-11-01

- 文稿引用和 Codex 回答引用新增“回到引用位置”按钮；待发送卡片及历史消息均可使用，沿用现有小图标和悬浮提示。
- 文稿引用通过 Overleaf 原生文件树／标签页打开原文件，在 Code 或 Visual 中选中并定位原文。文字位置变化时重新匹配原文；原文已删除或位置有歧义时提示，不按旧行号猜测。
- 回答引用优先按消息标识定位，必要时分批读取当前对话的较早历史；定位后短暂高亮，保留草稿和引用，不恢复流式强制跟随。
- 仅更新浏览器扩展；本机 Codex 连接程序沿用 0.11.2，无新增权限。
- 验证：729 项前端测试、TypeScript 与构建通过；Chrome 人工页面验证 Code／Visual、跨文件、较早回答及草稿双引用定位。重新加载后的实页确认同文件 Code／Visual、未打开文件及回答定位正常，发现已打开缓存标签的跨文件超时；由 0.11.4 修复。

## 0.11.2 — 2026-11-01

- 修正独立 Codex / Desktop 问答及引导请求的 `additionalContext.name`：使用符合运行时约束的小写机器名称，保留原有选区、文件和回答引用。已用本机实际 Codex 运行时复现旧参数拒绝，并验证新参数完整通过；测试模型为本地模拟服务。
- 明确未被接口接受的请求不再留下乐观显示的假用户消息；独立连接只在 `turn/start` 确认后写入用户历史，失败时保留草稿。已接受或传输结果未知的消息不会被猜测删除、自动重发；不追溯改写旧日志。
- “处理期间的新消息”改为设置中的选项：排队（默认）或直接引导，输入区统一使用发送按钮与 Enter。排队条目提供“立即引导”，使用加入队列时保存的上下文；不支持引导的连接自动排队。
- 补齐 Visual 公式晚挂载、重新挂载和原生组件更新时的自定义宏覆盖恢复；持续在相邻正文输入时保留源码未变化的公式，避免原生未识别宏短暂露出。
- 同时更新浏览器扩展和本机连接程序，无新增权限。

## 0.11.1 — 2026-10-31

- 将扩展更新后的刷新入口改为原生侧栏尺寸的细线图标、小提示点和轻量浮窗，沿用 Overleaf 字体与颜色，保留键盘焦点和 Escape 关闭提示。
- Code / Visual 中主动取消选区或点击编辑器与 Codex 外部时清除待发送的文稿引用；进入提问框仍保留引用，清除后不会被旧选区重新附加。
- 为 Visual 正文中未进入编辑状态的自定义宏公式补充项目宏渲染；保留原生公式容器、点击编辑和未知公式回退，不修改 LaTeX 正文。
- 本次仅更新浏览器扩展；本机 Codex 连接程序沿用 0.11.0，无新增权限。

## 0.11.0 — 2026-10-31

- 文本选区覆盖 MathJax 公式时，公式与文字使用一致的选中色；保留原生选区、LaTeX 复制和回答引用，支持反向选区及流式渲染后新增的公式。
- 新增“显示公式复制提示”，默认关闭；启用后，单击复制公式会显示短暂的小提示，不抢焦点、不新增逐公式按钮。设置继续使用 Overleaf 原生字体和控件。
- 回复期间支持“引导 / Steer”和“排队 / Queue”，停止使用独立按钮。排队时固定当前问题、引用、选区和文件上下文，按顺序发送；支持移除或取回编辑。停止、失败及刷新后暂停，不自动重发结果未知的问题；API 模式使用排队，Codex 使用本机支持的引导能力。
- 待发队列按账号与项目保存在 Chrome 本地存储，最多八条、总计 1 MiB；跨窗口写入先核对持久版本，只有成功保存“发送中”状态后才提交，避免旧窗口重复发送。模型来源和对话切换前须先处理当前队列。
- 修正 Desktop 寻找会话归属最多需 10 秒、旧连接却只等待 5.5 秒的问题。检查连接重新读取当前登录；归属变化时只在尚未提交问题前尝试同会话恢复，保留历史、不抢占写入锁。真实旧会话经官方导航重新打开后，已验证归属立即可达、模型可读取，未发送测试问题。
- 引导消息保留独立的稳定记录，不覆盖原问题。独立 Codex 校验目标轮次；Desktop 沿用其原生“引导当前回复”的行为，并确认实际接收轮次。
- 新的 Codex 问答将可见问题与文稿上下文分开传递，完整上下文仍以原生的非可信资料字段提供给模型。Overleaf 历史显示识别既有的 Desktop 引用包装，把问题和引用分开展示；长问题默认收起为约六行，可随时展开。历史原始日志不重写。
- 验证：646 项前端测试、192 项本机测试、TypeScript、构建、人工页面脚本编译及 diff 检查通过；已安装并核对本机连接程序。
- 新的界面和模型调用尚未做真实浏览器／推理验收：浏览器权限仍关闭，且电脑控制工具禁止操作 ChatGPT 自身。自动化验证结果见 dev/README.md 的本版验收记录。

## 0.10.0 — 2026-10-31

- Codex Assistant 新增“模型来源”，默认仍为 Codex；可保存多组 DeepSeek 或其他兼容 OpenAI Chat Completions 的 API 连接，并按 Overleaf 项目选择。
- 连接名称、API 地址、模型 ID 和密钥在扩展自己的配置页填写；密钥只保存在本机连接程序的私有文件中，不进入 Overleaf 页面、浏览器同步或聊天记录。已有连接地址固定，换地址需新建连接；没有新增 Chrome 权限。
- API 问答复用原有选区、附近文本、回答引用及有界项目上下文；支持流式回答、停止、新建／切换历史和 LaTeX 复制。历史按连接、Overleaf 账号与项目分别保存在本机，不同步进 Codex 桌面；切换来源保留各自历史、输入草稿及文稿选区，移除上一来源的回答引用。
- API 使用直接 HTTPS（或本机 HTTP）连接，不跟随重定向；检查连接只读取模型列表，不发送问题或文稿。请求失败不自动重发、不自动切回 Codex。停止会关闭本机请求，但服务商可能已经处理或计费。
- 本机连接程序新增 `api_provider.py`，需更新安装；API 模式无需运行 Codex 桌面。只支持兼容 Chat Completions 的服务，不泛指所有厂商的原生协议。
- 验证：618 项前端测试、161 项本机测试、TypeScript 和构建通过；包含真实回环 HTTP 的流式 UTF-8／取消测试、来源切换及历史隔离、选区上下文续聊和密钥边界检查。尚未提供真实服务商密钥，未进行真实 API 推理；浏览器工具报告 Work 关闭本地浏览器使用，因此本版新增界面的视觉验收仍待完成。

## 0.9.4 — 2026-10-31

- 桌面持有会话时改为通过其本机 owner/follower 通道直接提交，沿用原聊天和上下文；无需等待空闲锁释放，也不重启桌面、抢锁或复制对话。
- 接收版本化桌面消息快照与增量更新，保持流式回答；停止操作携带已确认的 turn ID，只停止当前由 Overleaf 提交的回复。独立读取端暂时报告的“已中断”不再提前结束回答；快速停止由桌面新快照确认，超限回答会停止已确认的本轮。
- 校验同用户私有 socket、peer UID、能力、owner、线程和协议版本；发送超时或结果未知时不自动重发。浏览器关闭不会停止桌面仍在进行的回答。
- 桌面路径显式传入只读、禁网络、无需批准、空环境与禁用插件列表，并使用问答约束；这是共享桌面运行方式，不宣称与旧独立进程完全相同的工具隔离。仅该会话的设置生效。
- 本机连接程序新增两个依赖免费的 Desktop 适配模块，需重新安装；Chrome 权限与原有 Preview、选区和引用 UI 不变。
- 验证：600 项前端测试、126 项本机测试、TypeScript 和构建通过。独立真实会话验证桌面持有时发送、流式回复、桌面续聊后再从 Overleaf 追问，以及当前选区优先于旧快照并读取另一项目文件。本机连接已安装并在现有网页重连，保留草稿、引用和六条历史；未向真实文稿会话发送测试问题。

## 0.9.3 — 2026-10-31

- 在单条 Codex 回答中选中文字后，输入框上方显示“引用所选内容 / Quote selected text”；点击后附到下一条问题，可展开查看或移除。每次保留一段回答引用，再次引用会替换它，可与文稿选区同时使用；添加引用不会自动发送。
- 引用保留跨段文字、代码换行和公式 LaTeX；选区端点落在公式内时使用该公式完整源码。引用操作不改动系统剪贴板。
- 已发送的回答引用保存在浏览器显示缓存与本机会话历史中，刷新、分页和同步时恢复。协议保持版本 1，引用作为独立字段传送并明确标为旧回答资料；本机数据库兼容迁移，不丢弃旧历史。
- 没有新增权限或网站匹配范围。更新时需重新运行 `native/install_codex.py --install` 更新 Codex 连接程序，再重新加载扩展、刷新 Overleaf。

- 验证：TypeScript、600 项前端测试、63 项 Codex 后端测试及构建通过；真实 Overleaf 已验证回答选区、公式还原、引用展开与移除。发送与历史恢复通过人工后端及自动化测试验证，本轮未发送新的模型问题。

## 0.9.2 — 2026-10-31

- 在 LaTeX Visual 模式中编辑公式时沿用扩展的 MathJax / TeX 预览，补齐后台语法解析、公式组件展开和模式切换的更新。
- 在同一 CodeMirror 测量周期内同步公式与位置；重复几何更新不重启渲染或 TeX 输入等待，退出公式或关闭增强预览后隐藏弹窗。
- 保留原生 Visual 的静态公式展示、自动补全、Codex 选区和原稿编辑行为；没有新增扩展权限。
- TypeScript、572 项前端测试与构建通过；Chrome 人工页面验证首次 Visual、延迟解析、行内／独立公式、连续输入局部标红与模式往返，真实网站已验证直接以 Visual 加载、切换现有自定义命令公式、离开／返回和 Code／Visual 往返；未修改原稿。

## 0.9.1 — 2026-10-31

- 同一会话在 Codex 桌面续聊后的问题和回答自动显示到 Overleaf：可见面板每五秒读取，返回页面或打开面板时立即读取；以稳定消息 ID 更新，保留草稿、引用、旧消息与阅读位置。
- 发送前核对最新历史版本，每轮使用新建的本机服务恢复该会话，结束后释放自己的写入占用。桌面回复中、历史未知或写入锁仍由桌面持有时拒绝发送并保留问题，不自动重放或分叉。桌面端仍可能在空闲时持锁，因此本版不承诺任意时刻的双向发送交接。
- 移除逐公式 Copy TeX 浮层；设置增加默认关闭的“单击公式复制 LaTeX”，点击时仅短暂淡色反馈。整条回答和普通选区的源码复制保留。

- 验证：567 项前端测试、72 项本机测试、TypeScript 与构建通过；实页恢复历史与公式、原生字体、单击复制系统剪贴板通过。合成双客户端验证 writer 冲突和释放，不消耗模型 turn。

## 0.9.0 — 2026-10-31

- 增加项目对话历史入口。本机按 Overleaf 账号与网页项目保存并补齐已登记会话的完整问答，支持列表分页、切换／重读当前会话、加载更早消息和在 Codex 桌面打开；新建对话保留旧会话。加载旧消息保留已有渲染节点与阅读位置。
- 将这台 Mac 的已有扩展会话归入 Codex 应用中的 Overleaf 项目，并为后续会话配置工作目录；网页项目之间仍独立。安装程序支持 `--workspace` 指向已有 Codex 项目。
- 在 Codex Assistant 设置中增加左右面板位置及标题栏快捷切换，按项目保存；右侧融入布局，可与左侧文件树同时打开，拖拽方向随位置调整。
- 增加整条回答原始 Markdown／LaTeX 复制、单公式 Copy TeX，以及普通选区跨 SVG 公式时复制原 LaTeX；剪贴板回退保留原焦点、草稿与选区。
- 补采 Code 选区并支持 LaTeX Visual 的源码映射，优先可见主编辑器，在切入 Codex 前捕获选区。Visual 使用真实 TeX 及源码行号，不以可见文字伪造源码范围；PDF、独立 `.bib` 表单和不能映射的公式组件子选区不支持。
- 区分正常后台休眠、临时连接中断与真正的扩展上下文失效；只读请求可重连重试，提问和会话变更不自动重发。失效时提供点击刷新提示；页面 body／head 重建后恢复入口、样式、草稿和主题。
- 区分历史读取与模型生成的忙碌状态，历史操作不再显示 Thinking 或不可用的 Stop；当前历史项可重新读取，便于恢复初次加载失败。
- TypeScript、541 项前端测试、62 项本机测试与构建通过。真实 Overleaf 已验证 Code／Visual 选区与焦点转移后的引用、右侧布局及刷新持久、四条既有历史和 110/110 个公式、系统剪贴板的整条回答／单公式复制、14px Noto Sans 原生设置和八个模型。未发送新的模型请求、修改原稿或重置真实对话；恢复路径与跨窗口竞争另由自动化测试覆盖。详见 dev/README.md 的 0.9.0 验收记录。

## 0.8.2 — 2026-10-30

- 打开 Codex Assistant 设置时自动读取本机模型列表，保留各模型支持的推理强度；提供加载状态、失败重试，异步更新不覆盖未保存设置。成功结果在当前页面复用五分钟，正在回答时延后检查。
- 恢复 Overleaf 原生设置的字体与尺寸，去除让子导航和控件误继承父容器大字号的样式。保留 Extension 左侧 02 头像和紧凑说明文字。
- 侧栏入口和图标按钮增加可见的悬停／键盘焦点提示；思考状态放到回答的 Codex 标签旁。按用户要求使用本机官方应用包中的 Codex 图标，限此个人扩展使用。
- 发送的问题保留选区的文件、行号与可展开原文；引用随有界面板历史保存；超长回答保存明确标记的节选，保留问题与选区，旧记录按问答组保留，避免大回答导致历史被清空。
- 流式回答保留已有段落与公式节点；用户上移后按可见段落保持阅读位置，公式后续渲染也保留位置，可点击“回到最新回复”恢复跟随。
- 移除回答最多渲染 80 个公式的截断，改为分批渲染全部公式；保持代码块原样和单个公式的安全／资源限制。
- 增加 127 个公式、约 15 秒流式输出、模型加载失败重试和原生字号对照的人工测试场景。TypeScript、484 项单元测试（39 个文件）及构建通过；Chrome 本地人工页面已完成模型重试、字号、引用、提示、127/127 个公式、滚动位置及主题／语言检查。真实 Overleaf 0.8.2 已确认自动列出 8 个模型、原生字号、键盘焦点提示、选区卡和既有回答 87/87 个公式重渲染，原有两条历史保留；本轮实页没有新推理请求，长流式回复与发送后引用检查仍属人工页面验收。

## 0.8.1

- 修复深色主题下 Codex 侧栏标题及回答标题被 Overleaf 全局标题颜色覆盖的问题。
- 已在真实 Overleaf 页面验证两级设置、模型连接、选区引用及浏览器到 Codex 的公式回复。

## 0.8.0 — 2026-10-30

- Turn the native Settings → Extension entry into a disclosure with Preview and Codex Assistant children. Preserve the 02 avatar, existing preview controls, independent drafts and native tab restoration; follow the site's English/Chinese language and native row styling.
- Add a Codex Assistant rail entry immediately below Overleaf's AI assistant, with a resizable chat panel, source-selection attachment, streamed answers, mathematical rendering, stop and new-chat controls.
- Capture Code editor selections with file and line context. Reuse the read-only project snapshot for bounded project context, prioritizing live editor content and marking omitted or excerpted material. No Git integration is required.
- Add per-account/project assistant settings, bounded local display history and independent native Codex conversation bindings. This is read-only Q&A: responses are applied manually and the extension does not edit the manuscript.
- Add the separately installed `com.overleaf.personal_tools.codex` Native Messaging host using the local Codex login and app-server. Install with `native/install_codex.py --install`; the existing TeX host stays separate. Model/status checks do not submit an inference request.
- Extend synthetic tests and the local development fixture for settings, rail/panel behavior, selection, streaming and native protocol boundaries. The fixture is explicitly labeled artificial testing and returns fixed simulated answers; these checks do not establish live Overleaf or real Codex conversation acceptance.

## 0.6.0 — 2026-10-30

- Own the complete formula popup, anchored by the host editor's measured coordinates. Hide native previews while enabled; do not use native render results or require the native Equation preview setting.
- Render unknown or unsupported commands in red while retaining the rest of the formula. Keep strict rendering for audits and retain resource limits; unfinished structure uses escaped source text.
- Replace typing/loading/error banners with frame-scheduled MathJax drafts. TeX compiles after a typing pause and replaces the draft atomically; compiler details remain in settings.
- Preload the renderer, avoid resetting unchanged requests, separate document snapshots from index rebuilds, and retain the prior frame during edits at the same formula location.
- Separate geometry updates from rendering and reject stale geometry and asynchronous results. Add independent-popup, typing, request-lifecycle and synthetic performance checks.

## 0.5.0 — 2026-10-30

- Style extension completion source labels with Overleaf's interface font, small muted text and centered alignment; keep native suggestion rows untouched.
- Own preview content from the pending stage onward, show cached formulas immediately and use native fallback only after extension failure with a matching formula witness and a successful native SVG.
- Support LaTeX's math-mode `ensuremath` semantics, including nested project macros, argument grouping, relation spacing and script binding.
- Adapt the bounded `DeclareMathAlphabet` family `OML/cmm/b/it` to MathJax bold italic, independent of the custom command name; retain explicit unsupported diagnostics for other fonts. Fix matrix completion snippets to preserve row separators.
- Add bilingual preview-source switches and ordering in the native Extension panel. Keep command completion independent, deduplicate local style files, and retain per-project preferences.
- Replay enabled definitions for MathJax and apply source controls only to isolated TeX preview copies. Preserve the original event order for unchanged ordering, retain normal TeX declaration errors, and reject unsafe dynamic rewrites explicitly.
- Check standard font, bold, operator and package commands, source conflicts, settings persistence and source-order cache invalidation.
- Add reusable explicit-file MathJax and sandboxed TeX macro audit runners, with representative calls, source fingerprints and separate unsupported/font/setup classifications.

## 0.4.2 — 2026-10-29

- Support native absolute-positioned tooltip portals as well as fixed positioning. Verified fallback placement uses viewport coordinates and releases all overrides when native ownership resumes.
- Check ancestor containing blocks before applying fixed placement; do not guess through transforms or layout containment.

## 0.4.1 — 2026-10-29

- Replace repeated tooltip recovery measurements with a narrowly scoped CSS position override. Late native hidden-position writes no longer compete with the extension; selection, scroll, resize and teardown release the override.

## 0.4.0 — 2026-10-29

- Follow Overleaf’s selected interface language for English and Chinese settings, controls, help and extension-owned status/diagnostic messages. Keep formulas, file paths, project names and raw compiler logs unchanged.
- Centralize typed panel translations and language detection; preserve draft controls during in-page language changes without recompiling formulas.
- Support the verified Chinese site cn.overleaf.com alongside www.overleaf.com, retaining exact host and same-origin transport checks.
- Use an isolated mock cloud transport for the local UI fixture rather than weakening production origin checks.

## 0.3.1 — 2026-10-29

- Place the personal 02 avatar before the Extension label, matching native tab icon placement.
- Match native tab weight and supplementary link typography.
- Capture native main-document changes before asynchronous control updates can restore an older value.
- Recover below-formula placement if a later native measurement hides the managed popup again.

## 0.3.0 — 2026-10-29

- Match native Overleaf settings typography and controls; replace the broken icon ligature with an Extension label and the configured personal avatar.
- Follow the actual Overleaf main-document setting automatically; reserve manual selection for unresolved ambiguity and legacy overrides.
- Replace the long extra-file list with a collapsed searchable picker and removable selections.
- Keep the existing formula popup visible below a visible formula near the editor’s top edge when native above-only placement cannot fit; retain native positioning in other cases.
- Preserve a newer native main-document selection if older metadata arrives late.

## 0.2.2 — 2026-10-29

- Use Overleaf’s existing tooltip reposition event after asynchronous preview content, image loads and cached results; request native placement after content changes. Later live testing found that native above-only placement still hides formulas near the editor’s top edge; addressed separately in 0.3.0.

## 0.2.1 — 2026-10-29

- Fixed the pinned legacy socket client under strict-mode bundling; its private wrapper receives the isolated realm global without modifying the website socket object.
- Added build-level regression tests for the real vendor client.
- Verified live native TeX, MathJax custom-macro preview and command completion in a dedicated synthetic Overleaf project. Cloud preview acceptance continues using the already-created preview clone.

## 0.2.0 — 2026-10-29

- Added two-stage native settings: MathJax or TeX, then local or Overleaf compilation for TeX.
- Added single-formula TeX documents using the full identifiable preamble and configured extra files; bundled PDF.js displays single-page output.
- Added explicit creation of bound Overleaf preview clones, changed-text synchronization, per-compile entry overrides and build-specific PDF/log retrieval. Binary changes and stale deleted/renamed paths require a new clone; original contents/settings are not overwritten.
- Added an optional macOS Native Messaging host with Python standard-library transport, temporary text-only jobs, sandboxed installed TeX, cancellation and resource limits. No localhost service is used.
- Added stable extension identity and nativeMessaging permission; raised the browser baseline to Chrome 145 for bundled PDF.js runtime requirements.
- Added tests for TeX document construction, cloud/native transport boundaries, cancellation/failures and PDF lifecycle. Live Overleaf cloud end-to-end acceptance remains pending installation and disposable-project validation.
- Documented TeX Live clone differences, body-state/resource limits and the continuing catalog/parser boundary of command completion.

## 0.1.0 — 2026-10-29

- Project-based macro package discovery and configurable auto/manual/no-extra-file modes.
- Native settings integration, command completion with parameter navigation and undo.
- Native Code-mode formula popup enhancement with local, isolated MathJax rendering.
- Bounded project snapshots, live declaration updates, diagnostic support reporting, synthetic regression tests.
