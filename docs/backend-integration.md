# Go 服务接入

本文件由 `callum-desktop` 仓库维护，说明桌面客户端如何启动随附 Go 程序、转换协议及管理连接。Electron 窗口、界面组件和状态管理见 [桌面端架构](architecture.md)，程序来源、哈希及兼容基线见 [服务程序资源](../resources/backend/README.md)。

## 文档归属与核对依据

| 维护位置          | 文档                                                             | 负责内容                                                 |
| ----------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| `callum-desktop`  | 本文件                                                           | 子进程、通信限制、数据路径、业务字段转换及联调边界       |
| `callum-desktop`  | [桌面端架构](architecture.md)                                    | Electron 进程、IPC、组件、交互与客户端资源所有权         |
| `callum` 后端仓库 | `docs/development.md`、`docs/storage.md`、`docs/architecture.md` | Go 的运行配置、存储行为及内部模块职责                    |
| `callum` 后端仓库 | `docs/tools-and-approvals.md`、`docs/context-compaction.md`      | 工具、审批、命令执行与上下文预算                         |
| `callum` 后端仓库 | `docs/jsonrpc.md`                                                | 请求、响应、通知、错误码和字段契约                       |
| `callum` 后端仓库 | `docs/design/conversations.md`                                   | 数据一致性、恢复、压缩、权限判定及平台沙箱实现与验收范围 |

跨仓库引用以仓库名和仓库内路径标识，不依赖开发者本机绝对路径。修改接入前核对后端当前工作区与协议，并用客户端实际随附程序验证；后端源码中的能力与已随附二进制的能力分别确认。运行客户端不依赖 Go 源码仓库或本机 Go 环境。

## 程序与数据路径

- 开发与本地构建预览从应用构建位置解析仓库 `resources/`，发布程序以 `process.resourcesPath` 为资源根目录。
- macOS x64/ARM64 分别选择 `backend/darwin-x64/callum`、`backend/darwin-arm64/callum`；Windows x64/ARM64 分别选择 `backend/win32-x64/callum.exe`、`backend/win32-arm64/callum.exe`。服务与客户端架构一致。程序位于 ASAR 外，macOS 保留执行权限，其他目标明确拒绝。
- 四个平台的 Python/Node 资源选择 `runtimes/unpacked/<平台>/`，开发构建前从仓库 `runtimes/archives/` 离线生成。主进程以独立的 `--runtime-dir` 启动参数传入绝对目录，Go 读取清单并校验全部文件；版本固定为 Python 3.14.10、Node 26.13.0。运行时资源及私有数据目录互不包含，程序执行由 Go 命令工具持有。准备流程见 [桌面端开发](development.md#内置-pythonnode-资源)。
- 安装包资源映射尚未配置；后续配置须按上述目录复制目标资源，约定见 [资源约定](../resources/backend/README.md)。Windows 原生联调仍待 Windows 环境验证。
- `backend/data-directory.ts` 统一计算 Go 数据目录：默认由系统家目录得到 `~/.callum` 的绝对路径，开发、预览和发布一致。显式设置 `CALLUM_USER_DATA_DIR` 时优先使用 `<隔离用户数据目录>/backend`，测试不会访问真实家目录。`ChatService` 接收已确定的绝对数据路径，不再自行附加 `backend`，通过 `--data-dir` 传给服务。
- 新服务数据目录权限为 `0700`，不擅自改变已有权限。数据库、配置、模型凭据及实例锁均由 Go 管理，Electron 不直接读取或修改 SQLite。Electron 缓存和外观偏好仍使用原系统应用数据目录。
- 原 `userData/backend` 保留，不自动迁移、合并或删除；目标 `~/.callum` 存在时读取其中的数据，不覆盖为旧目录内容。已有数据格式的校验和升级由 Go 处理，不能让两个服务同时占用同一目录。
- 默认新目录没有模型，用户通过“设置 → 模型”配置供应商和模型，保存后可直接用于对话。不会复制源码仓库的日常数据或凭据；Go 的数据目录实例锁防止多个服务同时使用同一数据库。

Electron 的缓存与外观偏好仍独立保存，开发及本地构建预览使用系统应用数据位置下的 `Callum Development`，发布运行使用 Electron 对应的用户数据目录。隔离启动命令见 [开发文档的数据目录说明](development.md#数据目录与通信边界)。随附程序的数据库版本与升级限制见 [资源兼容说明](../resources/backend/README.md#随附程序兼容说明)。

## stdio 传输与连接生命周期

`rpc-client.ts` 无 Shell 启动固定程序，stdout 只作协议通道。持续消费 stderr，握手前最多保留 16 KiB 诊断，从结构化启动错误中识别数据目录占用和内置运行时校验失败并转换为固定提示；未知诊断只给出就绪前退出信息，不转发原文。握手成功、失败或关闭时清理缓冲，运行后只消费，避免对话与凭据进入界面或客户端日志。客户端仅在应用边界记录脱敏故障，当前不写入客户端文件日志。

- 逐行 UTF-8 JSON-RPC 2.0，以字符串请求 ID 关联响应；使用有界字节缓冲处理分片、粘包和 UTF-8 边界，拒绝损坏数据。
- 就绪通知验证服务名、协议版本 `1` 和当前通信上限；启动等待 15 秒。
- 请求最多 1 MiB、响应帧最多 8 MiB；最多 64 个待处理请求，stdin 写队列最多约 2 MiB。
- 单次 RPC 等待 15 秒，发送响应表示受理，回答完成另由执行事件决定；不会让 RPC 超时承担整个模型执行时间。
- 超时后受理结果未知，关闭连接并提示核对历史，禁止自动重试写操作。

应用级 `ChatService` 持有唯一 Go 子进程与 RPC 连接。Go 启动失败时以全窗口失败页展示安全原因并提供“重试启动”。macOS 关闭窗口后持续消费服务输出，不取消执行；重新创建窗口时通过查询恢复。

服务生命周期由客户端主进程维护，通过固定的 `getServiceState` 和 `onServiceState` 桥接传入界面，不新增 Go 协议方法。`starting` 等待握手，`ready` 表示已通过就绪校验，`startup-failed` 表示未能完成启动并保留安全原因，`failed` 表示运行中断连，`closing` 在停止受理和关闭资源之前发布；进入关闭后不再发布就绪或失败。启动准备与正常关闭展示全窗口 loading，启动失败显示全窗口失败页，运行中断连沿用会话内的明确错误。通知仅发送给当前可信窗口，窗口重新创建时读取快照。

`retryServiceStart` 仅重试启动失败：等待旧初始化及子进程清理完成后，按原固定路径和数据目录重新启动；并发请求共享一次重试，旧进程无法确认退出时不创建新进程。再次失败保留新原因，成功后重读初始业务数据。重试与应用退出协调，关闭开始后不再启动。运行中断连不能调用该入口重启，不自动重放对话或工具操作。

应用退出时停止受理业务请求，发送 `system.shutdown` 并等待服务取消、清理及退出。协议关闭最多等待 3 秒，随后等待自然退出 3 秒、SIGTERM 2 秒、SIGKILL 2 秒；超时记录关闭失败。服务异常断开拒绝所有待处理请求并标记结果未知，通过有界终止清理自有进程；初始化失败同样释放已创建资源，关闭可重复调用。恢复依靠重新打开应用后查询持久化状态，不自动重新执行写请求。

## 模型配置适配

`main/backend/model-catalog.ts` 复用 `ChatService` 的唯一 RPC 连接，通过固定的供应商和模型接口保存配置，不创建额外进程或直接访问数据库。IPC 分别暴露查询、供应商保存/删除、模型保存/删除及模型启停，不接受任意方法名。

- `shared/models.ts` 校验配置字段、UUIDv7、长度、HTTP/HTTPS 根地址和明确的密钥操作；拒绝 URL 内的账号密码、查询参数、片段及未知输入字段。服务类型选项集中定义在 `PROVIDER_SERVICES`，类型由选项推导；当前仅提供 Chat Completions（`chatcompletions`）。供应商新增默认选中，编辑回填已保存的类型；主进程校验后按所选协议提交。未知已有类型不会被静默改为默认值。后续扩展选项时必须同时落实 Go 服务对应的协议支持。
- 配置写入互斥，拒绝并发重复操作；失败后释放写入状态。API 返回成功并核对记录标识后才显示已保存；列表加载失败与写入失败分开提示，不自动重发写请求。
- `model.update` 是完整替换。适配层保存基础字段前读取最新模型，保留后端已有的 `max_output_tokens`、`capabilities` 和 `reasoning_levels`，避免未编辑的元数据被清空。模型配置的 `inputTypes` 数组回填 `model_type` 中的 `text`、`image`；表单固定选择文本，图片可选。IPC 拒绝缺少文本、重复项和未提供的类型选项；保存时合并最新模型中未展示的其他类型，不改写 `capabilities.image_input`。未提交 `inputTypes` 的内部调用保留原有类型，读取旧配置时不自动改写数据库。对话概览的 `imageInput` 仍从 `model_type` 是否包含 `image` 派生。`contextWindow` 映射 Go 的 `context_window`，可在模型编辑表单中填写 1 至 1000000000 的整数；新建不预填容量，旧配置缺失时明确补充，界面不猜测厂商容量。未提交该字段的内部调用保留后端原值。
- 供应商编辑留空密钥时不发送 `api_key` 字段；只有明确替换或清除时才传入值。列表只返回 `hasApiKey` 状态，客户端不请求或回显已有密钥。
- 凭据存储仍由 Go 服务持有。随附服务将 API Key 以 AES-256-GCM 密文保存在本地 SQLite，主密钥由 macOS 钥匙串、Windows Credential Manager 或 Linux Secret Service 持有；客户端不管理或导出主密钥。系统凭据不可用时明确失败，不回退明文。客户端不把密钥写入 localStorage、sessionStorage、查询快照或日志；关闭编辑弹窗时销毁表单的临时凭据状态。
- 客户端不使用模型 SDK、厂商预设或自动模型发现。实际模型网络请求由 Go 执行。

## 项目目录与业务存储边界

项目目录选择由主进程的系统选择器记录实际路径和目录身份，新增目录在提交前再次复核。固定的 `updateWorkspace` IPC 将名称、完整目录列表及原目录快照交给服务端；Go 在写事务中检查快照、活动执行和路径冲突，原子保存结果。仅改名不提交目录字段。目录解除关联不移动或删除磁盘文件，无目录项目不提供隐含相对路径基准。

项目、会话、置顶、归档、软删除、模型配置和审批由 Go 持久化，客户端只维护有界快照及窗口内草稿。数据库结构和升级实现由后端维护，随附版本的兼容说明保存在资源清单，不在客户端重复实现迁移。

## 历史分页

`ConversationHistoryReader` 复用唯一 RPC 连接调用 `conversation.history`。每页最多 25 个完整执行，消息与执行来自同一服务端读事务，包含没有消息的手动压缩；以 `before_run_id` 严格向前翻页、以 `has_more` 判断结束。页面内消息 content 编码累计有 4 MiB 限制，可能少于 25 轮。消息、执行、游标、归属和排序在主进程及 preload 校验。`getConversationHistory` 是固定业务 API，不提供任意 RPC 转发。

首次详情和向前翻页使用同一契约，不再把旧消息与最新 200 条执行拼接。主进程按页分类手动压缩，查询期间合并该页的较新事件；分支变化时拒绝旧页，避免把已替换回答接回界面。无消息的压缩页仍可继续向前。桌面端历史分页统一通过 `getConversationHistory` 使用执行游标。消息页、手动压缩位置和独立活动执行的所有权见 [桌面端架构](architecture.md#桌面-api-与状态)。

## 业务适配与事件

`protocol-mapper.ts` 将 Go 字段转换为界面需要的类型，不传递厂商配置。`chat-service.ts` 负责调用固定方法、拼接文本增量、处理归属并构造一致快照：

- `conversation.send` 首次提问创建会话；历史上下文、模型调用和标题均由 Go 管理。
- `conversation.resend` 使用固定会话、用户消息及模型 ID，Go 校验最后一条提问和活动执行。适配层校验受理结果及 `removed_message_ids`，排空旧增量、清理内存旧回答，并发布按新执行标识关联的 `messages-removed` 客户端通知；通知参与同一有界队列和快照回放，查询期间的旧回答不能覆盖已移除状态。旧执行步骤及审计仍由 Go 保存。协议及 Go 服务实现保持现有契约。
- `message.delta` 追加到指定消息和内容块，`message.updated` 使用完整消息替换本地内容，工具调用前的中间文本可以被清空。
- 消息的 `created_at`、`completed_at` 经查询和完整消息事件分别映射为 `createdAt`、`completedAt`，以毫秒时间戳传递并校验；缺失或空值保留为未知，不用 `updated_at` 或客户端当前时间补造完成时间。
- 活动消息在主进程持有，界面关闭后仍消费流；重新打开窗口可读取尚未完全落库的回答。终态时释放对应活动缓存。
- 完整消息通知按约 16ms 合并（完成、取消和断连前立即排空增量）；快照协调记录最多 512 条、16 MiB，超出恢复窗口时要求重新加载，不返回不一致快照。
- `ChatEventDelivery` 每次向窗口发送一条通知，preload 在处理后通过固定内部通道确认。等待期间按实体合并最新快照，队列最多 128 个实体、16 MiB；积压超限时提示重新查询。确认和订阅通道同样校验来源，不暴露给业务界面。
- 正常结束、失败、取消、重启后的中断与连接断开分别处理。`persisted:false` 保留落库失败提示，不把内存中的终态当作已安全保存。

补充输入的 `user_input.requested/updated` 事件映射为 `ChatUserInput`，校验会话、执行、步骤和问题标识；`user_input.list` 恢复等待快照，回复通过固定 `submitUserInput` IPC 提交。问题与回答由 Go 保存在 `user_input` 步骤中，等待不持有模型调用槽位或数据库事务；服务重启只恢复中断状态，不自动继续。

界面的编辑表单、审批与补充输入卡片见 [对话交互与卡片](architecture.md#对话交互与卡片)。

## 步骤查询与输出

`ChatService` 通过既有 `step.created`、`step.updated` 和 `tool.output` 通知维护有界的步骤快照。`message.delta` 同时按 `step_id` 保存模型说明文字，工具调用轮清空回答消息时不会清除对应步骤文字。工具或提问步骤通过 `parent_step_id` 标记产生它的模型步骤；首个回答模型步骤可以缺少 `purpose`，后续回答、辅助标题及摘要仍按已有用途字段区分。工具输出为 base64 字节，每个步骤的 stdout/stderr 独立增量解码 UTF-8，缺片或超出缓存时标记截取，不将片段当成最终结果。

preload 只暴露固定的 `listRunSteps(conversationId, runId, afterSequence)` 和 `getStepDetails(conversationId, runId, stepId)`，主进程校验运行或步骤的会话归属。列表复用 `step.list` 并合并查询期间的实时快照，每页 50 条；详情按 `step.data` 返回的 UTF-8 字节偏移分页拼接，最多读取 8 MiB，展示最多 256 Ki 字符。过程文字从统一 `context_message` 恢复，不让界面解析厂商响应；原始工具输出、审批及操作事实仍来自服务记录。

过程分组、思考预览、压缩状态与滚动窗口见 [调用过程展示](architecture.md#调用过程展示)。原始工具输出和步骤终态由服务端保存，实时片段不承诺重放；断线后重新查询有界最终结果，不将片段视为成功凭据。

## 执行设置与审批边界

执行权限通过固定 getExecutionSettings/updateExecutionSettings IPC、preload 校验和 ChatService 转换 settings.get/update。输入框的审批菜单与权限对话框共用 sandboxMode、approvalPolicy、approvalsReviewer 和 revision。三种模式映射到用户审核、AI 审核和显式完全访问。设置 revision 冲突和断连失败可见，保存后只影响新任务。审核结果和理由来自服务端审批记录与工具步骤，转人工时沿用既有审批卡片。

审批展示读取 Go 生成的 details.execution_boundary、writable_roots、Windows 的 readable_roots 和 justification。只读沙箱展示临时目录和网络限制，沙箱内项目写入展示固定项目及其可能发生的修改或删除，沙箱外请求展示当前系统用户的文件和网络权限。旧审批没有边界字段时保留原展示。Windows 读取范围为固定项目/cwd/程序目录与系统已有授权；现有保护目录的 ACL 不等价于 Seatbelt 对未来同名目录的动态路径规则。Electron 窗口沙箱与 Go 命令沙箱是独立边界。

当前 Go 源码联调中，on-request 允许普通本地读取和只读沙箱命令自动执行，Go 自身数据目录由后端工具及平台沙箱隔离。macOS/Windows 项目写入命令、已识别危险命令和明确沙箱外请求逐次审批。历史只读目录授权继续查询和撤销。

Windows 已接通 AppContainer、限制令牌与 Job 的平台边界：受限模式默认只读、网络关闭，项目写入需单次审批；完全访问模式使用当前系统用户权限。每次执行独立 SID 的 ACL 与恢复日志由 Go 持有，客户端不设置或回收文件权限。Windows 原生测试尚未运行，不能声称实际行为已验收。权限弹窗按应用平台说明该差异，审批卡继续读取服务端固定快照。命令详情按记录中的 Windows 盘符或 UNC 路径显示 PowerShell 风格参数和提示符，Unix 路径使用原有展示格式；跨平台查看历史时依据记录中的执行位置。

具体的审批策略、AI 审核、目录授权、ACL 回收和恢复机制由后端 `docs/tools-and-approvals.md` 与 `docs/design/conversations.md` 维护。客户端读取固定快照并提交决定，不设置或回收文件权限，不以卡片文字替代服务端判定。批准不表示操作成功，取消不表示操作一定未发生。

## 上下文、推理与过程说明

`getContextUsage` 通过固定 IPC 查询 `conversation.context_usage`；主进程将 `conversation.context_usage.updated` 转为界面数字快照。普通草稿仅参与只读估算，不调用模型或持久化。估算和实际输入用量分别传递，未知容量、失败或断连不补造数值；上下文圆环及命令候选共用统计状态，详细交互见 [功能文档的对话过程与滚动](features.md#对话过程与滚动)。

`compactConversation` 调用 `conversation.compact` 并使用当前选中的模型；受理只表示建立执行，状态从执行及压缩步骤恢复。客户端区分实际生成摘要、没有较早完整轮次和未知结果，不向界面传送摘要正文，也不因查询失败自动重跑压缩。Token 预算、完整批次、来源指纹、摘要切换与中断恢复由后端负责，见后端 `docs/context-compaction.md` 及 `docs/design/conversations.md`。

独立推理只读取模型步骤的 `reasoning.delta` 与统一 `output.reasoning`，不从正文标签推测；旧记录缺失时保持缺失。原始 usage 由 Go 保存，客户端不改写或用估算代替真实用量。

主对话的操作前说明由 Go 固定系统提示引导所选模型生成，提示每轮加入且参与 Token 预算；标题、摘要及 model.invoke 不受此提示影响。客户端沿用 message.delta 与模型步骤的 context_message，工具子步骤出现后将父模型步骤标记为 commentary，RunTimeline 按步骤顺序展示说明和工具；最终正文独立。重启后从步骤结果恢复原文。未输出说明时保留原工具记录，不构造成功或进度文本，不增加补写模型请求。

提示的定义、注入与预算处理由后端维护，见后端 `docs/design/conversations.md` 的工具与审批实现约定。

API Key 的旧明文在 Go 启动时迁移，结构版本为 4；失败阻止业务启动并保留可重试状态。密文携带主密钥标识，同一系统用户移动目录仍可读取，跨机器复制数据库不会携带系统主密钥。旧备份和系统快照不由迁移擦除。详细迁移、恢复及平台要求由后端 `docs/storage.md` 维护。配置错误 `1012` / `credentials_unavailable` 通过现有错误通道展示，不自动重试写操作。

## 会话图片附件

Electron 从用户选择、粘贴和拖放的文件取得有界字节，主进程在隔离的附件暂存目录生成临时文件。`conversation.send` 与 `conversation.resend` 通过 stdio 传入临时路径，Go 保存原图到 `<data-dir>/attachments/`。主进程完成请求后清理暂存文件，取得后端实例锁后回收上次异常退出的暂存内容。已受理消息使用 `attachment_ref`。编辑重发提交原执行标识和保留图片索引。历史预览通过消息索引调用 `conversation.attachment_preview`，界面无需读取任意本地路径。草稿图片数量通过 `draft_images` 计入上下文估算。

## 联调与验证边界

集成测试运行资源目录中的实际 Go 程序，使用独立临时数据目录和本机受控 HTTP 响应，验证模型配置、密钥保留/替换/清除、元数据保留、流式、并行隔离、取消、失败、审批、应用退出和历史恢复。受控响应形状参考后端的 `internal/app/agent_test.go`，这些结果不代表真实模型厂商兼容性。

业务集成测试在 macOS arm64 和 Windows x64 上启用。受控命令使用 Node.js 执行，测试通过父进程、可执行文件及隔离数据路径定位自己的服务。Windows 使用本机 CIM 进程查询，macOS 使用 `ps`。平台沙箱业务测试在两平台启用，Windows 专项覆盖只读自动执行、项目写入审批、执行快照、完全访问和关闭最后窗口后的取消与资源释放。后端 Windows 原生测试另覆盖权限及进程隔离、ACL 回收与恢复；本机只有交叉编译结果。Windows 实机结果与 macOS 回归结果分别记录。

联调使用绝对路径的 `CALLUM_USER_DATA_DIR`，不访问日常数据库，不复制凭据。数据库迁移、命令权限与后台资源恢复由 Go 验证；客户端测试关注协议适配、状态展示和连接生命周期。开发检查命令见 [桌面端开发](development.md#开发与检查命令)。
