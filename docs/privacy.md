# 数据、权限与保留

本说明对应当前 GitHub 分发的 Overleaf Personal Tools。扩展没有发布者后台、广告或遥测端点。它会处理文稿、问题和回答；选择云端预览或发送助手问题时，相关内容会离开设备，不能笼统描述为“所有数据仅在本机”。

## 内容流向

| 功能 | 读取／处理内容 | 接收方与用途 |
| --- | --- | --- |
| 补全、MathJax | 当前编辑器、主文件、宏包、项目文本快照 | 浏览器内分析与渲染；项目下载使用已登录 Overleaf 的同源请求 |
| Overleaf 云端 TeX | 当前公式、导言区和所需文本依赖 | 当前账号的专用 Overleaf 预览项目，用于编译；不会把整篇正文作为预览入口 |
| 本机 TeX | 预览所需文本 | 本机隔离进程；临时目录在任务结束后清理，不由 helper 上传 |
| Codex 问答 | 明确发送的问题、项目要求、选区／引用及所选项目上下文 | 本机 Codex 及其已配置的模型服务，遵循 Codex 的正常处理与保留规则 |
| 自备 API 问答 | 问题、所选上下文、引用及续聊所需历史 | 用户选择的 API 服务；服务端保留与计费由该服务规则决定 |
| API 连接检查 | 保存的服务地址、密钥和 `/models` 请求 | 仅所选端点；不发送问题或文稿，也不等于验证实际模型回答 |

扩展利用 Overleaf 现有会话及临时页面 CSRF 令牌进行同源操作，不收集账号密码。Codex 登录由 Codex 自己管理。API 密钥只在扩展专用连接管理页输入，交给本机 helper 保存，不写入 Overleaf DOM 或 Chrome storage，不随连接元数据返回网页。地址使用 HTTPS，或仅本机 loopback 的 HTTP；请求不跟随重定向。更换服务地址必须新建连接，旧历史不会自动换目的地。

API 密钥文件使用权限限制，macOS 为私有目录／文件权限，Windows 为当前用户与 SYSTEM 的受保护 ACL；没有应用级加密，也不是 Keychain／系统凭据保险库。拥有当前系统用户权限的其他程序仍应视为可能访问本机数据。

## Chrome 权限

| 声明 | 用途 |
| --- | --- |
| `storage` | 保存项目设置、显示历史、待发送队列、账号与项目绑定及缓存协调元数据 |
| `nativeMessaging` | 与用户单独安装的 Codex/API、TeX helper 通信 |
| `alarms` | 在后台休眠后安排项目页面核对和临时源码回收检查 |
| `host_permissions`：英文／中文 Overleaf | 为项目页面存活核对读取相关标签页 URL，避免误删仍在使用的源码 |
| 项目页面内容脚本 | 仅在两站点的 `/project/*` 页面接入编辑器、补全、预览与问答 UI |

manifest 没有 `tabs`、`history`、`cookies`、剪贴板或所有站点权限。`host_permissions` 的站点授权与内容脚本的项目路径匹配是不同机制，不能把路径写法理解为所有浏览器 API 的路径级隔离。源码操作仍验证扩展 sender、顶层 frame、Chrome 提供的 documentId、来源、账号及项目。网页不能指定任意本机程序或将凭据提交到任意地址。

## 本机位置与保留规则

macOS 的产品根目录为 `~/Library/Application Support/OverleafPersonalTools/`；Windows 为 `%USERPROFILE%\.overleaf-personal-tools\`。根目录下：

| 位置／数据 | 保留与删除 |
| --- | --- |
| `codex-native-host/`、`native-host/` | 已安装程序和专用配置；对应安装器卸载时移除 |
| `codex-assistant/` | 助手本机历史、账号／项目绑定和相关数据；helper 卸载保留 |
| `codex-assistant/api-connections/profiles.json` | API 连接与密钥；在连接管理页删除连接会删除该密钥，但不删除聊天 |
| `codex-assistant/api/` | 按 API 连接分开的本机历史；不导入 Codex 桌面 |
| `codex-assistant/project-context/` | 完整项目快照、内容块及保留镜像；按缓存模式和显式清理管理 |
| Chrome 扩展本地存储 | 设置、有限显示缓存、排队项及协调状态；不使用 Chrome Sync |
| Overleaf 专用预览项目 | 云端预览文本与入口；由账号保留，需在 Overleaf 单独管理 |

Mac 的 Native Messaging manifest 位于 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`。Windows manifest 位于产品根目录的 `NativeMessagingHosts`，并在当前用户 `HKCU\Software\Google\Chrome\NativeMessagingHosts` 注册。只允许仓库固定扩展 ID。

助手浏览器显示缓存最多 60 条、合计 350000 字符，包含问题、回答和引用；完整历史另由本机 helper／Codex 保存。最近回答超出缓存预算时可能显示为历史节选，当前页面中的完整回答不因此截断。待发送队列另限 8 项、总计 1 MiB，保存问题、引用、设置、源码快照引用及必要上下文；旧格式可能包含文本。刷新后暂停，不自动恢复发送。账号无法识别时，相关会话和队列不会按猜测的账号持久化。

默认按需缓存只回收可确认安全的新临时版本：最后一个项目页面离开后经过宽限期，且没有正在读取、排队或结果不明的受保护请求。浏览器关闭、后台休眠或连接失败不等同于已经清理。旧版和本地保留版本不会因切换模式自动删除。保留镜像不回写 Overleaf，也不应手动编辑。

**Clear retained source**仅清理当前账号／项目的源码及未完成上传；先核对版本与占用状态，可能因受保护任务而拒绝。它不清空聊天、API 配置或 Overleaf 原文件。旧聊天引用的源码版本清除后可能无法恢复，当前稿件不能替代当时原稿。新建聊天、删除 API 连接、卸载扩展和卸载 helper 都不是统一的“删除全部数据”操作。

## 用户控制与问题反馈

可关闭单项功能、切换普通上下文、移除待发送引用、删除队列项或 API 连接，并显式检查／清理项目源码。停止请求不保证远端服务已停止处理或计费。扩展不自动切换服务或重发结果不明的问题。

当前公开反馈入口为 [GitHub Issues](https://github.com/FuXihhy/overleaf-personal-tools/issues)。请使用合成项目描述问题；不要公开密钥、登录文件、完整个人配置、私人稿件或聊天。安装报告与截图仍可能包含本机路径、账号或项目标识，分享前应核对。此数据说明没有向任何商店提交隐私认证；服务商自身的数据政策不由本项目替代。
