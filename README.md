# Callum Desktop

Callum 的 Electron 桌面客户端，使用 TypeScript、Vue 3 和 shadcn-vue。

当前已建立可运行的应用外壳、受限桌面通信、新对话空状态、工作区与对话导航，以及包含外观分类的统一设置页面。后续将随客户端嵌入 Callum Go 服务，由主进程通过 stdio JSON-RPC 对接。服务进程、会话读写、Agent 和模型调用尚未接入；界面不展示内部服务连接提示。已核对的服务端情况与后续接入方向见 [架构文档](docs/architecture.md#callum-后端)。

## 环境与启动

- Node.js **26.13.0**，由 nvm 管理；npm **11.20.0**。
- macOS、Windows 或 Linux 的 Electron 运行环境。实际验证平台以交付记录为准。
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
src/
  main/
    index.ts                    应用入口和启动失败处理
    application.ts              装配应用级资源与窗口生命周期
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
      conversation/             新对话页面与发送不可用状态
      settings/                 设置页面与分类装配
      appearance/               外观设置内容及全局主题生命周期
    lib/                        桌面桥接入口等界面基础能力
    styles/                     Tailwind 和主题变量
  shared/                       不依赖运行环境的契约与校验
tests/
  unit/                         来源策略、资源边界与通信数据测试
  e2e/                          真实 Electron 应用验证
docs/
  architecture.md               依赖方向、资源所有权与扩展方式
```

界面调用链是 **Vue → DesktopApi → preload → IPC handler → 主进程能力**。共享模块不反向依赖任何进程，界面不直接访问 Node.js 或 Electron。

完整说明见 [架构文档](docs/architecture.md)。

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

Electron 测试直接使用项目中的 Electron，不需要另外下载 Playwright 浏览器。测试会创建独立临时用户目录，并在退出后清理；截图和失败产物保存在忽略的 `.artifacts/` 下。

## 导航、设置与组件

- 默认显示新对话页面，侧栏提供新对话入口、工作区分组与对话分组；对话分组用于未归属工作区的会话，工作区接入后展示其所属会话。
- 底部仅提供统一的设置入口，当前可用分类为外观。其他设置按实际功能接入，不展示未实现的配置项。
- 后端接入前，工作区与对话列表为空；添加工作区、消息输入和发送不可用，并提供相应说明。打开新对话页面不创建业务记录，也不生成占位会话。

- 支持跟随系统、浅色和深色主题，监听系统外观变化。
- 外观偏好保存在当前设备的页面存储中，仅包含主题枚举，不存放凭据或业务数据。
- 全局设计变量位于 `src/renderer/styles/main.css`，组件按 shadcn-vue 的源码方式维护。
- `components.json` 已配置路径。按实际需要添加组件，例如：

```bash
npx shadcn-vue@2.9.0 add button
```

执行 CLI 会下载组件并可能修改依赖，需要审查生成内容。CLI 不作为应用或常驻开发依赖安装；现有 Button 来自官方注册表，并按本项目的格式与默认属性要求调整。源码许可见 [第三方说明](THIRD_PARTY_NOTICES.md)。

## 数据目录与通信边界

开发及本地构建预览使用系统应用数据位置下的 `Callum Development` 目录；发布安装后的应用使用 Electron 对应的用户数据目录，工作区文件不放入这些目录。

开发或自动化验证需要隔离数据时，可以设置 **绝对路径** 的 `CALLUM_USER_DATA_DIR`。这会选择该次运行的用户数据目录，应用按需要创建它；不会自动删除目录。自动化测试负责创建及清理自己的目录。

```bash
CALLUM_USER_DATA_DIR=/absolute/path/to/isolated-profile npm run dev
```

上面的环境变量写法适用于 macOS/Linux；Windows PowerShell 使用 `$env:CALLUM_USER_DATA_DIR = 'C:\absolute\path\to\profile'` 后运行命令。

发布页面通过 `callum://app/` 加载，只服务构建后的界面资源。窗口启用沙箱与上下文隔离；IPC 校验所属窗口、主框架、页面来源和参数。新窗口、外部导航及页面权限默认拒绝。当前发布 CSP 不允许界面发起网络连接，后续后端接入应经过主进程的专用适配层。

## 协作

开发前阅读 [AGENTS.md](AGENTS.md)。技术栈、业务范围和发布行为分别确认；完成状态以实际代码及验证结果为准。

## 已知依赖审计项

2026-11-04 检查：`npm audit --omit=dev` 无报告项。完整审计仍报告开发工具链中的 [minimatch 中危公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)，关联 14 个开发依赖包。组件生成 CLI 已从常驻依赖中移除；未使用强制修复或跨主版本覆盖来改变检查工具的依赖契约，后续应随兼容的上游修复评估更新。
