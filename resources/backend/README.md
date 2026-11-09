# Callum 服务程序资源

本目录保存计划随客户端分发的 Go 可执行程序，按目标平台及架构组织：

```text
resources/backend/
  darwin-arm64/
    callum
```

当前随附 macOS Apple Silicon 的 Go 程序，由 Go 1.27.3 使用 `CGO_ENABLED=0`、`-tags release` 和 `-trimpath` 构建。该程序来自后端工作区基准提交 `7bd42b7` 及本次主要目录切换改动。SHA-256 为 `eb4fc31588d001e0eaf3b9121206126d0701a7fc9c029a8340e24d85fdb49eab`。

当前开发数据库基线为版本 `1`，建表包含 `workspace_additional_folders`。缺少该表的旧库会被结构校验拒绝，可用独立开发目录初始化空库。命令默认在只读 Seatbelt 沙箱执行，项目写入须逐次审批。内置文件工具和 Seatbelt 命令隔离应用数据目录。

`workspace.update` 支持通过 `root_path` 将已有源目录切换为主要目录，与名称更新原子提交。原主要目录保留为附加目录，项目标识和已有会话保留；有活动执行、目录不属于项目或与其他项目主目录冲突时拒绝切换。该能力复用现有表结构，不新增迁移。

## 打包资源约定

当前仓库只有 electron-vite 的源码构建流程，尚未配置安装包打包工具。放入本目录不等于已经纳入安装包；`npm run build` 不会自动复制此程序。

后续配置打包时，需要明确执行以下资源映射：

- 选择与目标平台及架构匹配的目录，不混入其他平台程序。
- 将 `resources/backend/darwin-arm64/` 复制到应用资源目录下的 `backend/darwin-arm64/`，保留可执行权限。
- 程序必须位于 `app.asar` 外。macOS 对应位置应为 `Callum.app/Contents/Resources/backend/darwin-arm64/callum`。
- 打包后由主进程基于 `process.resourcesPath` 定位该文件，不能依赖源码目录或当前工作目录。

以上是后续打包配置必须落实的约定，目前尚未配置或验证安装包资源复制。主进程已接入此目录中程序的启动和 stdio 通信：开发及本地构建预览基于应用构建位置解析仓库资源，发布程序基于 `process.resourcesPath` 定位。启动时显式传入家目录下 `~/.callum` 的绝对路径作为服务数据目录；设置 `CALLUM_USER_DATA_DIR` 隔离配置时改用 `<隔离目录>/backend`，不访问默认目录。旧的 `userData/backend` 不自动迁移或删除。运行客户端不依赖 Go 源码仓库或本机 Go 环境。

本目录是主进程需要的独立程序资源，不是渲染界面的 `public` 目录。当前渲染界面根目录为 `src/renderer`，其默认公共目录为 `src/renderer/public`。

关于可执行程序在 ASAR 外分发的原因，参见 [electron-vite 分发说明](https://electron-vite.org/guide/distribution)。

随附程序已接入独立推理：Chat Completions 的 `reasoning_content` 映射为模型步骤的 `reasoning.delta` 与统一 `output.reasoning`，支持取消和历史恢复，以及工具循环中的字段回传。推理计入内容与输入预算边界；不改写实际 usage，不增加数据库表或迁移。旧记录缺少统一字段时保持缺失。

随附程序已接入长工具链自动压缩：统一预检 Token、消息数量、上下文 JSON 和实际请求字节，在模型请求前及工具结果追加后尝试压缩较早完整批次。当前问题与正在执行的批次保留原文，步骤摘要携带来源范围、批次指纹及父检查点，校验后事务生效；失败保留原记录和旧摘要。旧长轨迹及历史消息支持有界恢复和分批压缩，重启继续时不重放工具，未知操作事实仍独立保留。复用现有步骤表，不增加迁移；验证使用受控模型及独立临时数据目录。

当前随附程序将会话业务更新输入与仓储快照参数分开，审批决定集中到 policy，执行轨迹及中断工具输出恢复集中到 agent/transcript；历史读取和压缩检查点共用恢复规则。JSON-RPC 方法、请求和响应字段、审批原因标识及步骤的 context_message、reasoning、operation 格式保持兼容，客户端继续通过现有通信适配读取并展示这些字段。

业务仓储的操作事实、最新检查点及恢复子查询使用 GORM 组合构造，JSON 与窗口表达式继续在 SQLite 内执行。查询保持最新结果的筛选顺序、当前分支隔离、容量检查和事务清理范围；检查点继续逐行读取。
