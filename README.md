# Callum Desktop

Callum 的 Electron 桌面客户端，使用 TypeScript、Vue 3 和 shadcn-vue。
客户端由主进程管理随附 Go 服务，通过 stdio JSON-RPC 使用对话、模型及工具能力。

## 功能概览

- 项目与独立对话管理，支持置顶、归档恢复、重命名及删除。
- 项目源目录增删和主要目录切换，供应商与模型配置，API Key 加密存储。
- 历史消息、流式回答、Markdown、独立推理展示、编辑重发和停止生成。
- 工具过程、审批、补充输入、上下文用量及手动压缩。
- 固定版本 Python 3.14.10、Node 26.13.0、Git 2.56.1 资源，由 Go 服务在既有权限与沙箱下执行。
- 外观设置、键盘操作及受限桌面通信。

对话支持添加图片、缩略图展示、放大预览和编辑重发；在模型设置的“输入类型”中勾选“图片”后使用，“文本”默认选中且不可取消。已有会话移动项目尚未接入。详细行为见 [功能与交互](docs/features.md)。

## 快速启动

开发环境使用 **Node.js 26.13.0**、npm **11.20.0**，Node.js 由 nvm 管理。
从仓库根目录执行：

```bash
nvm use
npm ci
```

完整 Python/Node/Git 归档已随仓库保存；`dev`、`build`、`test` 前自动使用随附 Go 程序离线解压当前平台资源，不需要访问上游下载地址或安装 Go。手动准备及维护方式见 [运行时资源准备](docs/development.md#内置-pythonnodegit-资源)。终端用户使用随附的 Python、Node 和 Git，无需另外安装 Python/Node/Git。

```bash
npm run dev
```

开发服务器监听 `127.0.0.1:5173`。安装和首次获取 Electron 需要网络访问。
随附服务及运行时覆盖 macOS Intel x64、Apple Silicon ARM64，以及 Windows x64、ARM64，均使用匹配的原生架构。
macOS ARM64 桌面已有验证，其他架构原生运行仍需对应环境验收。
Windows 开发、下载重试及隔离启动方式见 [桌面端开发](docs/development.md)。

## 文档导航

| 文档                                        | 内容                                             |
| ------------------------------------------- | ------------------------------------------------ |
| [桌面端开发](docs/development.md)           | 环境安装、工程结构、开发命令、数据目录与依赖审计 |
| [功能与交互](docs/features.md)              | 导航、项目、对话、模型设置、权限及过程展示       |
| [桌面端架构](docs/architecture.md)          | Electron 进程、IPC、Vue 状态、组件及资源所有权   |
| [Go 服务接入](docs/backend-integration.md)  | 子进程、stdio、数据路径、业务适配及联调边界      |
| [服务程序资源](resources/backend/README.md) | 程序来源、平台、哈希、兼容基线及资源映射         |
| [第三方说明](THIRD_PARTY_NOTICES.md)        | 组件源码与依赖许可说明                           |

Go 后端的实现和协议由独立的 `callum` 仓库维护，文档对应关系见 [Go 服务接入](docs/backend-integration.md#文档归属与核对依据)。

## 协作

开发前阅读 [AGENTS.md](AGENTS.md)。技术栈、业务范围和发布行为分别确认；完成状态以实际代码及验证结果为准。
