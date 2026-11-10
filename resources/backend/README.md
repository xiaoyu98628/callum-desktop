# Callum 服务程序资源

本目录保存客户端使用的 Go 可执行程序，按目标平台及架构组织。子进程、stdio 和业务适配见 [Go 服务接入](../../docs/backend-integration.md)；后端内部机制由独立的 `callum` 仓库维护。

## 程序来源与平台

程序按以下路径保存：

```text
resources/backend/
  darwin-arm64/
    callum
  win32-ia32/
    callum.exe
```

两平台程序来自后端工作区基准提交 `d49c9ca1e7a42aa67e1ea03c19b79f320bcc8448` 及本次历史分页、凭据加密、审核原始结果和迁移校验改动，保留已有 Windows 原生沙箱实现。源码指纹 SHA-256 为 `c8826143bfbe1d1aa009ee3f7ce8960e81c89788cd9a29995de007a5d55ed919`。计算方式：将 `go.mod`、`go.sum`、`cmd/` 与 `internal/` 下不以 `_test.go` 结尾的 Go 文件按仓库相对路径排序，依次拼接 UTF-8 路径、NUL、文件字节、NUL 后计算 SHA-256；指纹用于识别未提交工作区源码。

| 平台                | 构建参数（Go 1.27.3）                                            | SHA-256                                                            |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| macOS Apple Silicon | `GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 -tags release -trimpath` | `bbc06aff2381d31eba0136d9c76048ab28691913bb0e3137d12c546e5befed98` |
| Windows x86         | `GOOS=windows GOARCH=386 CGO_ENABLED=0 -tags release -trimpath`  | `f1bd8fd233184ed131bf19b58ac285f793a9d412d726431b2c2d75c259921a23` |

Windows x64 Electron 客户端固定使用 x86 服务，通过 WOW64 启动。两份程序均已验证交叉编译、文件格式和哈希；macOS 程序用于隔离桌面回归，Windows 原生启动及桌面联调仍待 Windows 环境验证。Linux amd64、Windows amd64 另做纯 Go 交叉编译检查，未作为桌面资源随附。

## 随附程序兼容说明

当前随附程序使用数据库结构版本 `4`。版本 `1`、`2` 和 `3` 会在启动实例锁保护下事务升级，保留原有项目、目录、会话、消息、步骤、审批、索引和触发器；结构升级失败回滚；旧 API Key 在系统凭据库可用后按事务加密，失败阻止启动并保留重试状态。外键设置在返回前恢复，其他不兼容结构明确拒绝打开。旧随附程序不支持打开已升级的数据库。升级实现与失败处理由后端维护。

| 接入能力     | 随附程序基线与客户端约束                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 项目目录     | `workspace.update` 接受完整目录列表和原目录快照，支持无目录项目、目录增删及主要目录切换；冲突、活动执行或原快照变化时拒绝保存，磁盘文件不移动或删除                      |
| 执行权限     | 支持用户审核、AI 审核和显式完全访问；macOS 使用 Seatbelt，Windows 已接入 AppContainer，但 Windows 原生启动、隔离强度与外部工具兼容性尚未验收；两平台程序使用本次相同源码 |
| 历史与凭据   | `conversation.history` 同页返回完整执行及消息，包含独立手动压缩；API Key 使用 AES-GCM，系统凭据库持有主密钥，无明文回退                                                  |
| 独立推理     | `reasoning.delta` 与统一 `output.reasoning` 和回答正文分开；旧记录缺失时保持缺失，不改写实际 usage                                                                       |
| 长任务与恢复 | 支持完整工具批次自动压缩、摘要来源及检查点恢复；保留原始轨迹，恢复不重放工具操作                                                                                         |
| 上下文统计   | 支持 `conversation.context_usage` 只读查询与 `conversation.context_usage.updated` 通知；草稿仅参与估算，不调用模型或持久化，实际输入与估算分别提供                       |
| 协议兼容     | 会话更新、审批策略集中与轨迹恢复的内部调整保持现有 JSON-RPC 字段以及步骤的 `context_message`、`reasoning`、`operation` 格式兼容                                          |

Go 的模块拆分、GORM 查询、压缩算法、审批判定及 ACL 回收细节由后端仓库 `docs/architecture.md`、`docs/storage.md`、`docs/context-compaction.md`、`docs/tools-and-approvals.md` 和 `docs/design/conversations.md` 维护；请求及通知以其 `docs/jsonrpc.md` 为准。客户端接入与平台验收边界见 [Go 服务接入](../../docs/backend-integration.md#联调与验证边界)。

## 打包资源约定

当前仓库只有 electron-vite 的源码构建流程，尚未配置安装包打包工具。放入本目录不等于已经纳入安装包；`npm run build` 不会自动复制此程序。

后续配置打包时，需要明确执行以下资源映射：

- 选择与目标平台及架构匹配的目录，不混入其他平台程序。
- 将 `resources/backend/darwin-arm64/` 复制到应用资源目录下的 `backend/darwin-arm64/`，保留可执行权限。
- Windows x64 安装包将 `resources/backend/win32-ia32/` 复制到应用资源目录下的 `backend/win32-ia32/`，主进程解析 `process.resourcesPath/backend/win32-ia32/callum.exe`。
- 程序必须位于 `app.asar` 外。macOS 对应位置应为 `Callum.app/Contents/Resources/backend/darwin-arm64/callum`。
- 打包后由主进程基于 `process.resourcesPath` 定位该文件，不能依赖源码目录或当前工作目录。

以上是后续打包配置必须落实的约定，目前尚未配置或验证安装包资源复制。主进程已接入此目录中程序的启动和 stdio 通信：开发及本地构建预览基于应用构建位置解析仓库资源，发布程序基于 `process.resourcesPath` 定位。启动时显式传入家目录下 `~/.callum` 的绝对路径作为服务数据目录；设置 `CALLUM_USER_DATA_DIR` 隔离配置时改用 `<隔离目录>/backend`，不访问默认目录。旧的 `userData/backend` 不自动迁移或删除。运行客户端不依赖 Go 源码仓库或本机 Go 环境。

本目录是主进程需要的独立程序资源，不是渲染界面的 `public` 目录。当前渲染界面根目录为 `src/renderer`，其默认公共目录为 `src/renderer/public`。

关于可执行程序在 ASAR 外分发的原因，参见 [electron-vite 分发说明](https://electron-vite.org/guide/distribution)。
