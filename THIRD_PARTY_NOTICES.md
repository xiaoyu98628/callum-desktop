# 第三方源码说明

## 随附 Python 与 Node.js

`resources/runtimes/archives/` 保存 Astral python-build-standalone 的完整 Python 发行归档及 Node.js 官方完整发行归档。固定版本、目标架构、上游地址与 SHA-256 见 `resources/runtimes/sources.json`。

上游归档内的许可证和第三方声明原样保留，并随离线解压结果一同提供；其许可范围以相应归档内容为准。这些资源独立于 Electron 内部的 Node.js。资源布局和准备入口见 [桌面端开发](docs/development.md#内置-pythonnodegit-资源)。

## 随附 Git、Git LFS 与 Git Credential Manager

四平台 Git 完整归档来自 [desktop/dugite-native v2.56.1](https://github.com/desktop/dugite-native/releases/tag/v2.56.1)，未修改归档内容。Git 为 2.56.1（Windows 为 2.56.1.windows.1），上游同时带有 Git LFS 3.8.1、Git Credential Manager 2.9.1 及相关依赖。固定下载 URL、SHA-256 和资源路径保存在 `resources/runtimes/sources.json`。

归档中的许可证、版权和第三方声明随完整资源保留，适用许可以对应文件为准。Git 使用 GPL-2.0，Git LFS 使用 MIT，GCM 使用 MIT；配套组件遵循各自许可。对应源码可从 [Dugite 构建及依赖定义](https://github.com/desktop/dugite-native/tree/v2.56.1)、[Git v2.56.1](https://github.com/git/git/tree/v2.56.1)、[Git for Windows v2.56.1.windows.1](https://github.com/git-for-windows/git/tree/v2.56.1.windows.1)、[Git LFS v3.8.1](https://github.com/git-lfs/git-lfs/tree/v3.8.1)、[GCM v2.9.1](https://github.com/git-ecosystem/git-credential-manager/tree/v2.9.1) 获取。`resources/runtimes/licenses/` 另保留从相同标签取得的 Git、Git LFS、GCM 和 Dugite 许可证正文，补齐 macOS 上游归档未单独提供的许可文本。当前工作不包含安装包分发；分发时需继续保留随附声明，并按各组件许可提供对应源码及构建材料。

## shadcn-vue 组件源码

`src/renderer/components/ui/button/` 的组件源码来自 [shadcn-vue](https://github.com/unovue/shadcn-vue)，本项目对默认属性及格式作了调整。其许可证如下；该许可证仅适用于对应第三方源码，不替本仓库其他代码指定许可证。

```text
MIT License

Copyright (c) 2023 unovue

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
