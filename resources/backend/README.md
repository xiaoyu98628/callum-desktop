# Callum 服务程序资源

本目录保存客户端使用的 Go 可执行程序，按目标平台及架构组织。子进程、stdio 和业务适配见 [Go 服务接入](../../docs/backend-integration.md)；后端内部机制由独立的 `callum` 仓库维护。

## 程序来源与平台

程序按以下路径保存：

```text
resources/backend/
  darwin-arm64/callum
  darwin-x64/callum
  win32-x64/callum.exe
  win32-arm64/callum.exe
```

四平台程序均由包含通用技能加载、附件工具及内置 Python/Node/Git 资源接入的同一后端工作区构建。源码指纹 SHA-256 为 `0ba9aeaeea703b03acf95a9de1c162512f4559bca9dc09bafbadf15aef8cb9ea`。计算方式：将 `go.mod`、`go.sum`、`cmd/` 与 `internal/` 下不以 `_test.go` 结尾的 Go 文件按仓库相对路径排序，依次拼接 UTF-8 路径、NUL、文件字节、NUL 后计算 SHA-256；指纹用于核对构建使用的生产源码与依赖声明。

| 平台                | 构建参数（Go 1.27.3）                                             | SHA-256                                                            |
| ------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| macOS Apple Silicon | `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 -tags release -trimpath`  | `3084113c62945a388f4625d978f6cd970f0e4b992abc8fb57e90a213659d20b3` |
| macOS Intel         | `GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 -tags release -trimpath`  | `85462611e60be1cecae740efe62d0d27a6af852f12bf5df6890a1bd11511742b` |
| Windows x64         | `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 -tags release -trimpath` | `42513ae68d6965c95fa453427b13e3b47c1fea510e8438655098f53df482c841` |
| Windows ARM64       | `GOOS=windows GOARCH=arm64 CGO_ENABLED=0 -tags release -trimpath` | `987dd0e303c3ff945d43d24d2408063031ea11f914e81b3e08390719ce9b0b7f` |

四套程序采用客户端匹配的原生架构，均已验证交叉构建、文件格式及哈希。macOS ARM64 程序用于隔离桌面回归；macOS Intel 和 Windows x64/ARM64 的原生运行及桌面联调仍需对应环境验收。

## 随附程序兼容说明

主对话、技能目录和补充提问选用 [OpenAI 上游模型指引](https://github.com/openai/codex/blob/59ac39addbbcd3499319c805a916846ca8ac5fef/codex-rs/models-manager/models.json#L76) 的对应段落。主对话使用 Callum 身份，操作前说明在助理正文中发送，审批由服务端校验。技能经 `read_file` 读取 `SKILL.md`，补充提问沿用单问题与字符串选项。主对话模型请求携带该次执行的审批与沙箱设置快照和工作区路径信息，Token 预览使用同一套组装逻辑。手动压缩、自动压缩和运行内检查点要求模型输出简体中文的 UTF-8 纯文本交接摘要。摘要提示主体取自 [OpenAI 上游交接提示](https://github.com/openai/codex/blob/59ac39addbbcd3499319c805a916846ca8ac5fef/codex-rs/prompts/templates/compact/prompt.md)，Copyright 2025 OpenAI，采用 Apache-2.0 许可。

技能资源位于客户端 `resources/skills/.system/`，安装到 `DataDir/skills/.system/`。用户技能平铺且优先；旧随附内容完整匹配才备份迁移，用户改动保留。文档、表格、演示文稿及 PDF 指引通过 `publish_artifact` 交付本地会话附件。需要云端导入时交付可供用户导入的本地文件。运行时从实际数据目录的 `runtimes/{python,node,git,native}` 执行，版本及平台仅在清单中。`resource-lock` 与服务共用实例锁，不打开业务数据库，并提供只读的 `runtime.validate` 完整校验。附件另存按消息版本读取不超过 1 MiB 的分片，每片返回原件 SHA-256。

这组随附服务提供 `skills.list`，供客户端 `/` 菜单使用与 Agent 相同的技能目录。发送和重发支持独立的 `skill` 内容块，校验当前已安装的名称和入口；正文独立保存，模型上下文通过 `$技能名` 及定位元数据恢复引用。

四个平台均随附 LibreOffice、Poppler 和图像转换工具，位于 `native/`。macOS ARM64 的 `26.1111.10934-flat` 还提供 Artifact Tool 2.8.148。Intel Mac 和两个 Windows 平台的 `26.1111.10934-native` 提供 Word、PDF 脚本所需的 Python 库，原生转换仍需目标环境验收。详见 [技能资源与安装](../../docs/development.md#技能资源与安装)。

本次随附服务接受 `--runtime-dir`。客户端在资源锁内安装后传入实际 `DataDir/runtimes/`，固定 Python 3.12.14、Node 26.13.0 与 Git 2.56.1（Windows 为 2.56.1.windows.1）；资源清单及全部内容由 Go 校验，命令执行继续使用既有审批和沙箱。内置运行时的 `run_command` 定义版本为 `9`：模型每轮收到直接调用 `python3`/`node`/`git` 的示例及实际内置入口，不必由用户重复提醒。多个独立操作分别调用工具，目录查看优先使用 `list_directory`；不为打印分隔标题或串联独立命令构造 Shell 脚本。确需管道、重定向或条件控制时使用非登录 Shell，并引用 Python、Node、Git 的内置绝对路径。对仅包装普通程序或串联独立调用的 sh/bash -c 增加执行前拒绝，并返回字段级错误。完整模型响应中的坏参数 JSON 会使本轮整批工具不执行，再带服务端反馈重新生成；原响应与 usage 保留，相同坏参数无进展时明确结束。取消和其他错误不走此纠正路径。此功能不变更数据库结构，也不提供运行期下载或版本切换。完整上游归档保存在仓库 `resources/runtimes/archives/`，开发、构建和测试前由随附程序的 `prepare-runtimes` 子命令严格离线解压，不依赖 Go 源码或本机 Go；该子命令不打开业务数据库。来源和准备步骤见 [运行时资源准备](../../docs/development.md#内置-pythonnodegit-资源)。

单项工具参数超过 16 KiB 时保留明确的工具名和已接收字节数，流式读取及时关闭；确认整批尚未执行且没有取消、传输或保存错误后，反馈模型拆分小补丁或使用脚本生成大文件。相同超限参数无进展时结束，不执行部分批次。`apply_patch` 定义版本为 `2`，同步提示单次参数容量；不提高资源边界、不重放已完成操作。

当前随附程序使用数据库结构版本 `5`，新库按纯文本摘要约束初始化。仍要求 JSON 摘要的旧库在启动时会被拒绝，原库数据保留。桌面联调使用 `CALLUM_USER_DATA_DIR` 指向新的独立数据目录。符合当前摘要约束的版本 `1` 至 `4` 会在启动实例锁保护下事务升级，保留原有项目、目录、会话、消息、步骤、审批、索引和触发器；结构升级失败回滚；旧 API Key 在系统凭据库可用后按事务加密，失败阻止启动并保留重试状态。外键设置在返回前恢复，其他不兼容结构明确拒绝打开。旧随附程序不支持打开已升级的数据库。升级实现与失败处理由后端维护。

随附服务为后续消息提供持久队列、附件保管和当前执行引导。版本 `5` 新增 `conversation_followups`，符合纯文本摘要约束的旧库可自动保留数据升级。常规偏好保存到 `app_settings` 的 `general` 组，已使用版本 `5` 的库在下次启动时补齐此记录。

| 接入能力     | 随附程序基线与客户端约束                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目目录     | `workspace.update` 接受完整目录列表和原目录快照，支持无目录项目、目录增删及主要目录切换；冲突、活动执行或原快照变化时拒绝保存，磁盘文件不移动或删除                      |
| 执行权限     | 支持用户审核、AI 审核和显式完全访问；macOS 使用 Seatbelt，Windows 已接入 AppContainer，但 Windows 原生启动、隔离强度与外部工具兼容性尚未验收；四平台程序使用本次相同源码 |
| 历史与凭据   | `conversation.history` 同页返回完整执行及消息，包含独立手动压缩；API Key 使用 AES-GCM，系统凭据库持有主密钥，无明文回退                                                  |
| 独立推理     | `reasoning.delta` 与统一 `output.reasoning` 和回答正文分开；旧记录缺失时保持缺失，不改写实际 usage                                                                       |
| 长任务与恢复 | 支持完整工具批次自动压缩、摘要来源及检查点恢复。保留原始轨迹，恢复不重放工具操作。摘要与正文按各自模型请求期限等待响应，摘要超时提示保留历史。                           |
| 上下文统计   | 支持 `conversation.context_usage` 只读查询与 `conversation.context_usage.updated` 通知；草稿仅参与估算，不调用模型或持久化，实际输入与估算分别提供                       |
| 协议接口     | 消息历史统一使用 `conversation.history`；`conversation.messages` 已移除并返回 `-32601`，现有事件字段及步骤的 `context_message`、`reasoning`、`operation` 保持原有格式    |

四平台程序支持托管图片、保留原图重发、按消息索引预览和草稿图片用量估算。会话图片保存在数据目录的 `attachments/` 下。

图片输入由用户选择的 `models.model_type` 包含 `image` 启用，`models.capabilities.image_input` 只记录模型拥有的能力；未选中图片类型时不启用图片发送，普通文件选择和发送仍可用。客户端“输入类型”多选组固定保留文本，图片可选，保存时保留能力对象和未展示的其他类型。启动时保留既有模型选择。

Go 的模块拆分、GORM 查询、压缩算法、审批判定及 ACL 回收细节由后端仓库 `docs/architecture.md`、`docs/storage.md`、`docs/context-compaction.md`、`docs/tools-and-approvals.md` 和 `docs/design/conversations.md` 维护；请求及通知以其 `docs/jsonrpc.md` 为准。客户端接入与平台验收边界见 [Go 服务接入](../../docs/backend-integration.md#联调与验证边界)。

## 打包资源约定

当前仓库只有 electron-vite 的源码构建流程，尚未配置安装包打包工具。放入本目录不等于已经纳入安装包；`npm run build` 不会自动复制此程序。

后续配置打包时，需要明确执行以下资源映射：

- 目标目录为 `darwin-arm64`、`darwin-x64`、`win32-x64` 或 `win32-arm64`，只选择与客户端匹配的原生架构。
- 把 `resources/backend/<平台>/` 复制到应用资源目录 `backend/<平台>/`，macOS 保留可执行权限。
- 服务程序位于 ASAR 外；macOS 例子为 `Callum.app/Contents/Resources/backend/darwin-x64/callum`。
- 将已经离线准备的 `resources/runtimes/unpacked/<平台>/` 完整复制到 ASAR 外的同名 `runtimes/unpacked/<平台>/`，保留标准库、配套资源、许可证和 `manifest.json`，内容须与清单一致。
- 把 `resources/skills/` 复制到应用资源目录 `skills/`，保留技能正文、脚本和必要参考资料；初始化时由客户端安装到服务实际数据目录，不能用资源升级覆盖用户技能。
- 同时完整复制 `resources/runtimes/licenses/` 到资源目录 `runtimes/licenses/`，保留公共许可证正文和第三方声明。
- 发布主进程通过 `process.resourcesPath` 定位资源，不依赖源码目录或当前工作目录。终端用户无需访问归档来源，也不在启动时解压。

以上是后续打包配置必须落实的约定，目前尚未配置或验证安装包资源复制。主进程已接入此目录中程序的启动和 stdio 通信：开发及本地构建预览基于应用构建位置解析仓库资源，发布程序基于 `process.resourcesPath` 定位。启动时显式传入家目录下 `~/.callum` 的绝对路径作为服务数据目录；设置 `CALLUM_USER_DATA_DIR` 隔离配置时改用 `<隔离目录>/backend`，不访问默认目录。旧的 `userData/backend` 不自动迁移或删除。运行客户端不依赖 Go 源码仓库或本机 Go 环境。

本目录是主进程需要的独立程序资源，不是渲染界面的 `public` 目录。当前渲染界面根目录为 `src/renderer`，其默认公共目录为 `src/renderer/public`。

关于可执行程序在 ASAR 外分发的原因，参见 [electron-vite 分发说明](https://electron-vite.org/guide/distribution)。
