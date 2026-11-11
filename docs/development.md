# 桌面端开发

本文包含环境、工程结构、开发检查、数据隔离和依赖审计记录。所有命令均从仓库根目录执行；界面行为见 [功能与交互](features.md)，进程架构见 [桌面端架构](architecture.md)，Go 接入见 [接入约定](backend-integration.md)。

## 环境与启动

- Node.js **26.13.0**，由 nvm 管理；npm **11.20.0**。
- 随附 Go 程序及 Python/Node 归档覆盖 macOS Intel x64、Apple Silicon ARM64，以及 Windows x64、ARM64；服务与客户端使用相同架构。macOS ARM64 已有实际调用验证，其他目标原生运行及桌面联调仍需对应环境验收。
- 安装依赖需要访问 npm 注册表；首次启动或主动安装 Electron 二进制时需要访问其下载服务。

`npm run dev`、`npm run build` 和 `npm test` 的前置步骤使用仓库内归档离线准备当前平台运行时。资源布局和维护步骤见 [内置 Python/Node 资源](#内置-pythonnode-资源)。

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
    darwin-arm64/callum          macOS Apple Silicon 服务
    darwin-x64/callum            macOS Intel 服务
    win32-x64/callum.exe         Windows x64 服务
    win32-arm64/callum.exe       Windows ARM64 服务
  runtimes/
    sources.json                固定版本、来源和归档校验值
    archives/                   四平台完整上游归档（入 Git）
    unpacked/                   离线生成的完整运行时及清单（不入 Git）
scripts/
  prepare-runtimes.ts            调用随附服务离线准备资源
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

| 命令                       | 用途                                    |
| -------------------------- | --------------------------------------- |
| `npm run prepare:runtimes` | 从仓库归档离线准备当前平台运行时        |
| `npm run dev`              | 开发模式，启动 Electron 和热更新        |
| `npm run typecheck`        | 分别检查主进程、测试和 Vue 界面         |
| `npm run lint`             | 代码规范及跨进程导入边界检查            |
| `npm test`                 | 使用 Node.js 内置测试运行器执行单元测试 |
| `npm run format:check`     | 检查格式，不修改文件                    |
| `npm run format`           | 格式化文件，会修改源码和文档            |
| `npm run check`            | 类型、规范、单元测试和格式检查          |
| `npm run build`            | 类型检查并构建三个进程的产物            |
| `npm start`                | 用 Electron 打开已有构建产物            |
| `npm run test:e2e`         | 构建并在真实 Electron 中验证桌面行为    |

生产构建输出到 `out/main`、`out/preload`、`out/renderer`。`npm run build` 不生成安装包；安装格式、签名和分发方式在发布需求确定后配置。

Windows 开发环境使用 Node.js 26.13.0 x64，在 PowerShell 中执行本页的 `npm ci`、`npm run dev`，或执行 `npm run build` 后运行 `npm start`。Go 程序的平台选择与路径见 [Go 服务接入](backend-integration.md#程序与数据路径)，程序来源、哈希及安装资源映射见 [服务程序资源](../resources/backend/README.md)。Windows x64 与 ARM64 均使用对应原生服务；原生运行仍需 Windows 环境验收。

Electron 测试直接使用项目中的 Electron，不需要另外下载 Playwright 浏览器。测试会创建独立临时用户目录，并在退出后清理；截图和失败产物保存在忽略的 `.artifacts/` 下。

Electron 端到端测试默认设置 `CALLUM_TEST_BACKGROUND=1`，在隔离数据目录中保持窗口隐藏，不主动聚焦；macOS 同时隐藏测试应用的 Dock 图标。该开关只在非打包应用且显式提供 `CALLUM_USER_DATA_DIR` 时生效。后台测试禁用渲染进程后台节流以验证流式更新，不更改正常启动行为。

## 内置 Python/Node 资源

四个平台 `darwin-arm64`、`darwin-x64`、`win32-x64`、`win32-arm64` 均固定 Python 3.14.10 与 Node 26.13.0。Python 使用 Astral `python-build-standalone` 的 `20261110 install_only_stripped`，Node 使用官方完整发行包；标准库、配套文件、许可证均保留。

`resources/runtimes/archives/` 中的八份完整归档直接纳入普通 Git，单个归档小于 100 MiB；不使用 Git LFS。`sources.json` 记录版本、架构、上游来源、归档文件名、SHA-256 和入口。归档不会因克隆时的换行转换而改变。只有可重新生成的 `unpacked/` 被 Git 忽略；格式检查与 ESLint 忽略归档和上游解压内容。

正常开发无需 Go 源码或本机 Go。以下命令通过当前平台随附 `callum prepare-runtimes` 校验本地归档并解压：

```sh
npm run prepare:runtimes
npm run prepare:runtimes -- --all
```

第一条只准备当前平台，第二条准备全部四个平台。`npm run dev`、`npm run build`、`npm test` 均自动执行当前平台准备。归档缺失或校验失败直接报错，不访问 GitHub 或 Node 下载地址。随附服务的准备子命令只允许离线操作，不打开数据库或启动 stdio 服务。该离线约定仅针对内置解释器；`npm ci` 和首次获取 Electron 仍需各自的下载服务。

准备结果位于 `resources/runtimes/unpacked/<平台>/`，包含 Python、Node 及完整性清单 `manifest.json`。解压在隔离暂存目录进行，拒绝越界路径、硬链接和特殊文件，校验全部成功后才激活平台目录。每次准备都会验证归档及已有解压内容；重复执行不替换有效目录，损坏或版本不符拒绝覆盖。更新资源时应在新输出目录完成核验，并在服务关闭后替换生成目录，不能修改共享运行时安装第三方依赖。

维护者需要升级归档时，从 Go 服务源码仓库运行：

```sh
go run -mod=readonly ./cmd/prepare-runtimes \
  --sources /absolute/path/callum-desktop/resources/runtimes/sources.json \
  --output /absolute/path/new-runtime-output \
  --cache /absolute/path/callum-desktop/resources/runtimes/archives \
  --download
```

只有此独立维护命令显式传入 `--download` 才允许获取缺失归档；正常开发命令和应用启动不使用该选项。新归档及来源清单应一同评审入库，已有归档校验失败不会被自动覆盖。

主进程将 `runtimes/unpacked/<平台>/` 的绝对路径经 `--runtime-dir` 传入同架构 Go 服务。启动及执行时继续校验资源，执行、审批、沙箱、输出、取消和进程回收由 Go 持有。终端用户使用已随附的解释器，服务运行期不下载、不解压、不升级资源；设置中不提供多版本切换。

`npm run build` 不生成安装包。后续打包必须将目标 `backend/<平台>/` 与已经解压的 `runtimes/unpacked/<平台>/` 完整放入 ASAR 外同名目录；归档入库不等于已验证安装包复制。

macOS ARM64 的真实解释器及完整客户端调用链已验证；macOS Intel、Windows x64/ARM64 的资源校验与 Go 交叉构建不能替代对应设备的原生运行验收。

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
