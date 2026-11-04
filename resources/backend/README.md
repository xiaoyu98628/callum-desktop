# Callum 服务程序资源

本目录保存计划随客户端分发的 Go 可执行程序，按目标平台及架构组织：

```text
resources/backend/
  darwin-arm64/
    callum
```

目前只有 macOS Apple Silicon 产物，使用 Go 1.27.3、`CGO_ENABLED=0`、`-tags release` 和 `-trimpath` 构建，包含编译时服务端工作区的未提交改动。该目录不存放数据库、配置、凭据或其他用户数据。

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
