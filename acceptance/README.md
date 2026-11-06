# 安装后验收：先自动检查，再完成最少的真实交互

本指南面向安装本分支的 Windows 用户。验收脚本把构建、本机连接安装和检查集中到一个入口；登录、Chrome 加载扩展和实际问答仍由用户完成。**自动检查通过不等于浏览器交互已经通过**：只有你实际看到回答、预览和刷新后的历史，才能把相应项目记为通过。macOS 用户可以复用本页的合成项目、提问和通过标准，但应使用 [macOS 本机安装说明](../docs/codex-backend.md)，不要运行 Windows 脚本或 ACL 配置器。

## 1. 运行一次安装与自动检查

准备 Chrome 145+、Node.js 22+、pnpm 和 Python 3.9+，将此分支放在一个日后不会随意移动的目录。在普通 PowerShell 中进入仓库根目录，后续命令均在这里运行。只使用 MathJax 或 Overleaf 云端预览时，不必安装 TeX Live；本机 TeX 放在后面的可选步骤。

本指南随 Windows 开发分支提交；在 PR 合入默认分支之前，需要获取 `windows/install-and-compat-20261106`，而不是旧版 `main` 或 v0.12.14 发布包。已登录有仓库访问权的 GitHub 账号后，可下载该分支源码 ZIP，或使用：

```powershell
git clone --branch windows/install-and-compat-20261106 https://github.com/FuXihhy/overleaf-personal-tools.git
cd overleaf-personal-tools
```

使用 Codex 时，先正常打开并登录本机 Codex，并在其中添加你准备用来归档 Overleaf 工作的本地项目目录。下面的 `C:\path\to\Overleaf` 必须换成该目录的真实绝对路径，不必等于扩展源码目录，也不是 Overleaf 网页地址。脚本使用你执行它的 Python 作为本机连接运行时；以后移动或删除这份 Python，需要重新安装本机连接。

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --workspace 'C:\path\to\Overleaf'
```

`--setup` 会安装锁定的 JavaScript 依赖、构建 `dist`、注册本机连接、绑定指定 Codex 工作区，再做安装内容和实际后台健康检查。只有额外指定 `--local-tex` 或 `--tex-root` 时，才会在当前 Python 缺少 `pywin32` 时补装它；默认 Codex/API 安装不需要这项 TeX 依赖。默认不配置 TeX 权限，不向模型发送问题，也不加载浏览器扩展；登录、加载扩展和真实问答留给你完成。只使用自己的兼容 API、不使用 Codex 模型时，改用 `python -X utf8 scripts/windows-acceptance.py --setup --api-only`。这一安装路径只注册 API 所需的本机连接，不需要 Codex 程序、登录或工作区，也不修改已有 Codex reader 配置；实际 API 配置和问答按后面的“自备 API”一行完成，不要求 Codex 健康检查通过。

自动报告为 `artifacts/windows-acceptance.json`，可上传的合成 Overleaf 项目为 `artifacts/acceptance-project.zip`。终端和报告将自动通过、失败、跳过、待人工检查分别记为 `PASS`、`FAIL`、`SKIP`、`MANUAL`；需要的自动检查失败会返回非零退出码。`PASS` 只表示自动部分通过，仍须完成下面的真实交互。

以后只检查已安装内容和后台健康，省略 `--setup` 即可；已绑定的 Codex 工作区无需重复输入。维护者需要完整代码回归时可加 `--full`，它会运行前端检查与构建、原生单元测试，以及验收脚本本身的 `scripts/tests` 回归；普通用户无需每次安装都运行完整开发测试。纯自动检查不会创建聊天、消耗模型推理额度或自动测试你保存的 API key。

```powershell
python -X utf8 scripts/windows-acceptance.py
```

只使用 API 的用户在复查、`--full` 或 `--local-tex` 命令中继续加 `--api-only`，避免把未使用的 Codex 登录状态列为失败。

不需要把 Codex 密码、登录文件或 API key 交给脚本。安装和检查使用当前 Windows 用户；日常 Chrome、Codex 和 TeX 都不需要管理员运行。使用 Codex 时，首次安装或 reader 更新后，正常退出并重新打开一次 Codex，使它载入更新的项目读取工具；API-only 用户无需此操作。

## 2. 只在 Chrome 加载一次扩展

打开同一 Chrome 用户配置的 `chrome://extensions`，开启开发者模式，点击“加载已解压的扩展程序”，选择本仓库的 `dist`。已有同 ID 扩展时点击“重新加载”，不要卸载再装。固定扩展 ID 应为 `pffppbkokpnfafpechmlambifflkmbbn`。然后刷新 Overleaf 项目页；独立应用窗口也需要刷新。

确认 **Settings → Extension** 下出现 **LaTeX Preview** 和 **Codex Assistant**。Codex 用户在 Codex Assistant 中点 **Check connection**，应显示“本机后台已检查 / Local service checked”，并列出当前账号可用模型。扩展会自行启动独立 Codex 后台，因此退出桌面窗口后这项检查仍可能成功；它不证明桌面窗口正在运行，也不证明模型推理或项目源码同步已经成功。API-only 用户直接按后面的“自备 API”步骤添加并选择自己的连接，不必让默认 Codex 来源显示成功。

## 3. 上传合成项目，验证真正的项目问答

在 Overleaf 首页选择 **New Project → Upload Project**，上传脚本生成的 `artifacts/acceptance-project.zip`，将项目命名为 `OPT Acceptance`。ZIP 只有 [project/main.tex](project/main.tex) 和 [project/chapter.tex](project/chapter.tex)，都位于项目根目录；主文件应为 `main.tex`。它们只有合成文本，不需要复制自己的论文、密钥或工作文件。点击一次 Recompile，确认 PDF 中有两个章节和公式。如果没有使用脚本，也可将这两份文件加入一个新的空白测试项目。

以下跨文件问答用于 Codex；API-only 用户先按可选矩阵的“自备 API”一行验证普通上下文的真实问答，再在供应商支持 function calling 时选择追加跨文件检查。Codex 用户打开 **Settings → Extension → Codex Assistant**，保留 **On-demand cache / 按需缓存**，点 **Sync project cache**。等到显示 2 个源码文件同步成功后，选择实际列表中可用的模型；无需使用文档作者的模型名称。打开左侧 Codex Assistant，发送下面这一个问题。问题故意不提供两个测试值，以检验模型是否真的能读到两份文件。

```text
这是专用合成项目的安装验收。请通过项目读取工具分别读取 main.tex 和 chapter.tex，找出两文件中 sentinel 的值，只回答两行“文件名: 值”。不要修改文件，不要猜测。
```

通过标准是得到下面两行，并且刷新页面、重新打开 Codex Assistant 后，同一会话的问题和回答仍在。模型的文字表述略有变化可以接受，但文件名和两个值必须一致；仅显示模型列表、绿色状态或“同步成功”不能代替此项。

```text
main.tex: OPT-MAIN-7A91
chapter.tex: OPT-CHAPTER-63B8
```

## 4. 检查停止保留与公式预览

继续同一会话发送以下问题；这是第二次真实模型请求。看到 `STOP_KEEP_OK` 和若干行已经显示后，点击停止，等到 Stopped / 已停止，再刷新页面并打开原会话。通过标准是已显示的部分回答仍保留，没有自动重发，没有凭空多出重复问题。如果模型在点击停止前已经回答完，只能记为正常完成，不能记为停止验收通过；需要此项证据时再手动发起一次更长的测试。

```text
这是专用合成项目的停止验收。允许通过项目读取工具核对 main.tex 和 chapter.tex。请先输出 STOP_KEEP_OK 和公式 $x^2+y^2=z^2$，接着写80行编号句，每行约25个汉字解释一个初等数学概念。不要修改文件。
```

在 **LaTeX Preview** 选择 MathJax，进入源码中的 `$\cN=2$` 或 Gaussian 积分公式，确认浮窗显示公式；再切换 Visual，点击同一公式，确认自定义宏仍可预览。在源码空白处输入 `\c`，从补全列表选择带 `main.tex` 来源的 `\cN`，确认插入后用 Undo 撤销测试输入。不要把未选择补全时出现的菜单当作已验证插入。

到这里，日常 Codex + 浏览器预览的最小安装验收完成。下面只检查你准备使用的可选功能；未运行的项记录为“未测”，无需为了通过全部项目添加 API key 或配置本机 TeX。

## 可选功能与完整交互检查

| 功能 | 用户操作 | 通过标准 |
| --- | --- | --- |
| 桌面双向续聊 | 在网页 Conversation history 对该测试聊天点 Open in Codex，确认首轮回答；在桌面同一聊天发“这是双端验收，请只回答 DESKTOP_ORIGIN_OK”，完成后回到网页 | 网页同一会话出现这条新问题和 `DESKTOP_ORIGIN_OK`。同时检查桌面侧栏实际项目分类；工作目录和 backend 项目 ID 正确，不保证已进入桌面侧栏项目，需要时用 Move / 移动到项目 |
| 排队与引导 | 生成长回答时排入一条短问题；停止后刷新，查看暂停的队列；手动 Resume queue。需要 Steer 时，在 Codex 回复生成期间发送一次明确引导 | 队列只保留一个待发项，刷新不自动继续，恢复后只发送一次；Steer 的新要求进入正在生成的同一轮。API 连接通常使用排队，不能以排队结果冒充 Steer |
| 文稿与回答引用 | 选择测试文稿一段后进入聊天，查看引用、Go to source 和移除；选择回答文字，使用 Quote selected text 后再移除 | 引用对象准确，跨焦点保留，定位正确，移除后不再附带 |
| 公式复制 | 开启 Click formulas to copy LaTeX 及复制提示，在回答公式上点击，再在未发送输入框 Ctrl+V | 实际粘贴出 LaTeX 源码；只看到 Copied 提示还不够。检查后清空输入框，可关闭临时开关 |
| 自备 API | 在 Manage API connections 中自行填写供应商地址、模型和 key，保存后返回选择连接；只使用本测试项目，先用 Normal context 请求短回答与公式，再实际停止一次长回答 | 真实问答完成；停止不自动重发；刷新恢复历史。切回 Codex 时两类历史分离。API 对话不归入 Codex 桌面，模型目录成功不代表问答成功 |
| 云端 TeX | 在 LaTeX Preview 选择 TeX → Overleaf，按界面创建或关联一个专用预览工作区，检查连接后点合成公式 | 真实 TeX 图片出现；等待编译结果，不把即时 MathJax 草稿当成 TeX 成功。失败时复用同一工作区检查，避免反复创建项目 |
| 本机 TeX | 按下一节配置，然后选 TeX → Local / 本机并检查连接，再预览合成公式 | 显示 Windows AppContainer + Job Object 沙盒可用，且实际公式编译成功；不能只根据 TeX Live 已安装判断通过 |
| 缓存保留与回收 | Inspect local versions 查看临时版本；切 Keep project locally 后 Sync，确认 retained 增加；切回 On-demand，改动一行合成注释后再 Sync。关闭该项目所有页，保持 Chrome 运行，稍候重开并 Inspect | 有页面时不误删；最后一页离开并经过 30 秒宽限期、后台检查后，临时版本回收而 retained 保留。切换模式本身不会删除已有保留版本 |
| 显式清理 | 仅在可丢弃的测试项目中先 Inspect，再 Clear retained source，阅读并确认范围；完成后重新 Sync | 缓存归零、聊天历史和 Overleaf 原文件保留；重新同步恢复当前源码。旧版本可能无法从已改变的源码恢复，不能对原稿盲点清理 |

### 本机 TeX 的可选配置

本机 TeX 需要已经安装的 TeX Live，以及脚本所用 Python 中可用的 `pywin32`；脚本不会自动下载 TeX Live。若提示缺少 `pywin32`，在同一个普通 PowerShell 中、使用安装 helper 的同一份 Python 补装后再检查：

```powershell
python -m pip install pywin32
```

首次权限配置只给专用 TeX capability 读取/执行权限，保持原 ACL；不会给整个磁盘添加继承权限。仅当脚本或配置器明确报告普通用户无权配置时，才在管理员 PowerShell 中运行它给出的那条配置命令，然后回到普通 PowerShell 重跑检查。不要把整个安装流程或日常浏览器改为管理员运行，也不要关闭沙盒来绕过失败。详细机制和故障边界见 [Windows 开发版说明](../docs/windows-development.md#tex-一次性权限配置)。

已完成本机 TeX 安装和权限配置，只需额外验证时运行：

```powershell
python -X utf8 scripts/windows-acceptance.py --local-tex
```

需要首次配置时，在前面的安装命令中明确提供 TeX Live 根目录，例如把 `C:\texlive\2026` 换成自己的实际目录。只有显式 `--tex-root` 才会请求 capability 配置；脚本不会自动提权。

```powershell
python -X utf8 scripts/windows-acceptance.py --setup --workspace 'C:\path\to\Overleaf' --tex-root 'C:\texlive\2026'
```

## 更新、失败处理与验收记录

更新前等生成结束，保留未发送草稿，再更新源码并重新运行安装命令。已有工作区绑定会保留；Chrome 只需重新加载扩展、刷新项目页。需要更新桌面 reader 时正常重启一次 Codex。切换电脑时使用新电脑自己的登录、API 配置和工作区，不复制 `.codex`、API 配置文件或聊天数据库。

| 现象 | 下一步 |
| --- | --- |
| 找不到或无法唯一匹配工作区 | 确认该绝对路径已作为本地项目添加到 Codex，目录可用；不要把 Desktop 显示的项目 ID 猜填成 backend 项目 ID |
| 没有两个 Extension 入口 | 核对固定扩展 ID 和 `dist` 路径，重新加载扩展后刷新项目页；不是重新安装 Chrome |
| 后台检查通过，但缓存同步失败 | 等 Overleaf 保存，手动 Sync project cache，按实际错误处理；不能靠反复 Check connection 清除源码错误 |
| 发送前失败 | 草稿应保留；先核对原会话是否出现问题及回答，再决定手动重试，避免重复发送 |
| 本机 TeX 权限失败 | 完成一次指定目录的 capability 配置；MathJax 与云端 TeX 可独立验收，不回退为无沙盒本机编译 |
| 聊天未出现在桌面项目下 | 使用 Desktop 的 Move / 移动到项目并读回侧栏；这是独立分类，不能仅凭工作目录宣称自动归类通过 |

自动报告保留在本机 `artifacts/`，不自动上传。向维护者反馈时，附脚本最终状态、扩展版本、Windows/Chrome/Codex 版本，以及仅包含本合成项目的截图和下面的简短记录即可；不要附登录文件、API key、完整配置或真实稿件聊天。路径、用户名和项目链接仍可能识别本机环境，分享报告前请检查并删去不需要的部分。

```text
自动检查：PASS / FAIL（报告路径）
扩展入口、跨文件回答、刷新历史：通过 / 失败 / 未测
停止后保留、MathJax/Visual、补全撤销：通过 / 失败 / 未测
已测可选功能：
尚未测试或遇到的限制：
```

历史实测结果见 [0.12.16–0.12.17 连接修复与交互验收](../docs/windows-connection-acceptance.md)。那是维护者在指定设备上的记录，不是其他用户运行本指南后的自动结论。完整浏览器重启、前进后退缓存恢复、桌面正在持有会话写入权时的所有接管分支，应分别记录实际操作结果，不从普通刷新或最终历史同步推断通过。
