# 桌面端开发

本文包含环境、工程结构、开发检查、数据隔离和依赖审计记录。所有命令均从仓库根目录执行；界面行为见 [功能与交互](features.md)，进程架构见 [桌面端架构](architecture.md)，Go 接入见 [接入约定](backend-integration.md)。

## 环境与启动

- Node.js **26.13.0**，由 nvm 管理；npm **11.20.0**。
- 随附 Go 程序覆盖 macOS Apple Silicon（darwin-arm64）和 Windows x86（win32-ia32）；Windows x64 客户端通过 WOW64 使用 x86 服务。macOS 桌面对话已有验证，Windows 原生启动与桌面联调仍待 Windows 环境验收；其他平台尚无配套服务程序。
- 安装依赖需要访问 npm 注册表；首次启动或主动安装 Electron 二进制时需要访问其下载服务。

```bash
nvm use
npm ci
npm run dev
```

`npm run dev` 同时构建主进程和 preload，启动 Vue 开发服务器及 Electron 窗口。主进程和 preload 开启文件监听，界面使用热更新。开发服务器固定监听 `127.0.0.1:5173`，端口占用时明确失败，避免误连其他服务。

Electron 二进制默认在首次启动时下载。若 GitHub 下载失败，可按 [Electron 官方安装说明](https://www.electronjs.org/docs/latest/tutorial/installation) 单次使用镜像重试，不需要修改全局 npm 设置：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx install-electron --no
```

该写法适用于 macOS/Linux，并保留 Electron 包内的校验和验证。

Node.js 版本由 `.nvmrc` 和 `package.json` 约束。Electron 内置的 Node.js 随 Electron 管理，与本机开发环境分别管理。

## 工程结构

```text
resources/
  backend/
    darwin-arm64/callum          随附的 macOS arm64 Go 服务程序
    win32-ia32/callum.exe        Windows x64 客户端使用的 x86 Go 服务程序
src/
  main/
    index.ts                    应用入口和启动失败处理
    application.ts              装配应用级资源与窗口生命周期
    backend/                    Go 进程、stdio 请求与业务数据适配
    windows/                    窗口创建和导航限制
    ipc/                        IPC 接入、来源验证与结果构造
    security/                   本地协议、资源路径和 CSP
  preload/
    index.ts                    通过 contextBridge 暴露 DesktopApi
  renderer/
    main.ts                     Vue 入口
    app/                        根组件和页面装配
    components/layout/          应用外壳、工作内容侧栏与统一设置入口
    components/ui/              按需引入的 shadcn-vue 组件源码
    features/                   按功能组织的页面和状态
      conversation/             对话界面、草稿、模型选择和 Markdown 排版
      settings/                 设置页面与分类装配
      models/                   供应商、模型列表和配置表单
      appearance/               外观设置内容及全局主题生命周期
    lib/                        桌面桥接入口等界面基础能力
    styles/                     Tailwind 和主题变量
  shared/                       不依赖运行环境的契约与校验
tests/
  unit/                         来源策略、资源边界与通信数据测试
  e2e/                          真实 Electron 应用验证
docs/
  architecture.md               桌面进程、界面状态与资源所有权
  backend-integration.md        Go 子进程、stdio 与业务接入约定
  development.md                环境、工程结构、开发检查与数据隔离
  features.md                   导航、项目、对话与模型设置交互
```

界面调用链是 **Vue → DesktopApi → preload → IPC handler → Go 服务适配层 → stdio JSON-RPC**。共享模块不反向依赖任何进程，界面不直接访问 Node.js 或 Electron。

完整说明见 [架构文档](architecture.md)。

## 开发与检查命令

| 命令                   | 用途                                    |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | 开发模式，启动 Electron 和热更新        |
| `npm run typecheck`    | 分别检查主进程、测试和 Vue 界面         |
| `npm run lint`         | 代码规范及跨进程导入边界检查            |
| `npm test`             | 使用 Node.js 内置测试运行器执行单元测试 |
| `npm run format:check` | 检查格式，不修改文件                    |
| `npm run format`       | 格式化文件，会修改源码和文档            |
| `npm run check`        | 类型、规范、单元测试和格式检查          |
| `npm run build`        | 类型检查并构建三个进程的产物            |
| `npm start`            | 用 Electron 打开已有构建产物            |
| `npm run test:e2e`     | 构建并在真实 Electron 中验证桌面行为    |

生产构建输出到 `out/main`、`out/preload`、`out/renderer`。`npm run build` 不生成安装包；安装格式、签名和分发方式在发布需求确定后配置。

Windows 开发环境使用 Node.js 26.13.0 x64，在 PowerShell 中执行本页的 `npm ci`、`npm run dev`，或执行 `npm run build` 后运行 `npm start`。Go 程序的平台选择与路径见 [Go 服务接入](backend-integration.md#程序与数据路径)，程序来源、哈希及安装资源映射见 [服务程序资源](../resources/backend/README.md)。Windows ARM64 的资源与运行验证尚未落实。

Electron 测试直接使用项目中的 Electron，不需要另外下载 Playwright 浏览器。测试会创建独立临时用户目录，并在退出后清理；截图和失败产物保存在忽略的 `.artifacts/` 下。

Electron 端到端测试默认设置 `CALLUM_TEST_BACKGROUND=1`，在隔离数据目录中保持窗口隐藏，不主动聚焦；macOS 同时隐藏测试应用的 Dock 图标。该开关只在非打包应用且显式提供 `CALLUM_USER_DATA_DIR` 时生效。后台测试禁用渲染进程后台节流以验证流式更新，不更改正常启动行为。

## 数据目录与通信边界

Go 服务在开发、本地构建预览和发布运行时默认使用家目录下的 **`~/.callum`**，主进程根据系统家目录计算绝对路径并通过 `--data-dir` 传入，不依赖 Shell 展开 `~`。对话、模型配置及相关业务数据保存在此处；可执行程序仍位于客户端资源／安装目录。

Electron 的缓存与外观偏好独立保存：开发及本地构建预览使用系统应用数据位置下的 `Callum Development` 目录，发布安装后的应用使用 Electron 对应的用户数据目录。

随附 Go 程序的数据库版本、保留数据升级及旧程序兼容限制见 [随附程序兼容说明](../resources/backend/README.md#随附程序兼容说明)。

开发或自动化验证需要隔离数据时，可以设置 **绝对路径** 的 `CALLUM_USER_DATA_DIR`。设置后，Electron 使用该目录，Go 服务使用其下的 `backend` 子目录，**不访问默认的 `~/.callum`**。应用按需要创建目录，不会自动删除；自动化测试负责创建及清理自己的目录。该隔离优先级在开发和发布运行时一致，新建服务数据目录权限为 `0700`，不改变已有目录权限。

```bash
CALLUM_USER_DATA_DIR=/absolute/path/to/isolated-profile npm run dev
```

上面的环境变量写法适用于 macOS/Linux；Windows PowerShell 使用 `$env:CALLUM_USER_DATA_DIR = 'C:\absolute\path\to\profile'` 后运行命令。

发布页面通过 `callum://app/` 加载，只服务构建后的界面资源。窗口启用沙箱与上下文隔离；IPC 校验所属窗口、主框架、页面来源和参数。新窗口、外部导航及页面权限默认拒绝。发布 CSP 不允许界面发起网络连接；对话通过主进程的专用适配层访问本地 Go 服务，模型网络请求由 Go 持有。消息解析 Worker 只允许加载同源构建资源，不放宽页面网络或脚本执行策略。

## 已知依赖审计项

2026-11-04 检查：`npm audit --omit=dev` 无报告项。完整审计仍报告开发工具链中的 [minimatch 中危公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)，关联 14 个开发依赖包。组件生成 CLI 已从常驻依赖中移除；未使用强制修复或跨主版本覆盖来改变检查工具的依赖契约，后续应随兼容的上游修复评估更新。

## 系统凭据验证

非空 API Key 需要当前用户可用的系统凭据库；保存和迁移失败会显示错误，不回退明文。后端的加密及平台要求见 [Go 服务接入](backend-integration.md#模型配置适配)。macOS 原生钥匙串读写已用随机专用条目验证；Windows 和 Linux 的原生凭据读写仍需对应环境验证，交叉编译不代表原生验收。

Node / Electron 集成测试使用隔离临时目录。需要保存非空测试 API Key 的场景会创建该目录专属的系统主密钥，关闭服务后只删除该精确条目，不枚举、清理真实用户凭据。普通后端 Go 测试注入凭据替身。历史回归覆盖超过 200 轮的原执行读取、无消息压缩页、页边界和推理缓存容量；Electron 测试继续验证真实随附服务和桌面桥接。
