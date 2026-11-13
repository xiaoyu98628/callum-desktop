# 第三方源码说明

## 随附 Python 与 Node.js

`resources/runtimes/archives/` 保存 Python 3.12.14 和 Node.js 的完整发行资源。macOS ARM64 Python 使用用户提供的本机技能环境，其他三个平台使用 Astral python-build-standalone；Node.js 使用官方发行归档。固定版本、目标架构、上游地址与 SHA-256 见 `resources/runtimes/sources.json`。

上游归档内的许可证和第三方声明原样保留，并随离线解压结果一同提供；其许可范围以相应归档内容为准。这些资源独立于 Electron 内部的 Node.js。资源布局和准备入口见 [桌面端开发](docs/development.md#内置-pythonnodegit-资源)。

## 随附 Git、Git LFS 与 Git Credential Manager

四平台 Git 完整归档来自 [desktop/dugite-native v2.56.1](https://github.com/desktop/dugite-native/releases/tag/v2.56.1)，未修改归档内容。Git 为 2.56.1（Windows 为 2.56.1.windows.1），上游同时带有 Git LFS 3.8.1、Git Credential Manager 2.9.1 及相关依赖。固定下载 URL、SHA-256 和资源路径保存在 `resources/runtimes/sources.json`。

归档中的许可证、版权和第三方声明随完整资源保留，适用许可以对应文件为准。Git 使用 GPL-2.0，Git LFS 使用 MIT，GCM 使用 MIT；配套组件遵循各自许可。对应源码可从 [Dugite 构建及依赖定义](https://github.com/desktop/dugite-native/tree/v2.56.1)、[Git v2.56.1](https://github.com/git/git/tree/v2.56.1)、[Git for Windows v2.56.1.windows.1](https://github.com/git-for-windows/git/tree/v2.56.1.windows.1)、[Git LFS v3.8.1](https://github.com/git-lfs/git-lfs/tree/v3.8.1)、[GCM v2.9.1](https://github.com/git-ecosystem/git-credential-manager/tree/v2.9.1) 获取。`resources/runtimes/licenses/` 另保留从相同标签取得的 Git、Git LFS、GCM 和 Dugite 许可证正文，补齐 macOS 上游归档未单独提供的许可文本。当前工作不包含安装包分发；分发时需继续保留随附声明，并按各组件许可提供对应源码及构建材料。

## 随附原生技能工具

新增 Intel Mac、Windows x64 和 Windows ARM64 的原生分片取自 Codex Primary Runtime `26.1111.10934` 的开源组件。保留原程序、库、配套资源和随附许可。以下 SHA-256 对应上游原始归档，重新分片的 SHA-256 记录在 [资源清单](resources/runtimes/sources.json)。

| 平台          | 上游归档                                                                                                                                                   | 上游 SHA-256                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Intel Mac     | [Codex Primary Runtime](https://persistent.oaistatic.com/codex-primary-runtime/alpha/26.1111.10934/codex-primary-runtime-darwin-x64-26.1111.10934.tar.xz)  | `39e9f43d10b9c35ccbb63d785f079451adb379abdb8f5a6c93a72fbbe8eaac36` |
| Windows x64   | [Codex Primary Runtime](https://persistent.oaistatic.com/codex-primary-runtime/alpha/26.1111.10934/codex-primary-runtime-win32-x64-26.1111.10934.tar.gz)   | `713bf6332902c0f0debb162fc1644c7b934709188b336f1b442d9c79eefb9bd3` |
| Windows ARM64 | [Codex Primary Runtime](https://persistent.oaistatic.com/codex-primary-runtime/alpha/26.1111.10934/codex-primary-runtime-win32-arm64-26.1111.10934.tar.gz) | `5ced21ebaa5dccff5689ba79f2ddd8b906ad163a3e3e6f97b6565a6789c57c50` |
| Windows x64   | [LibreOffice 26.8.3](https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/x86_64/LibreOffice_26.8.3_Win_x86-64.msi.mirrorlist)            | `0e6918c273eabbdbbd800ee0dacbbf130a14c13c2e4cec861b06dd59e015bf94` |
| Windows ARM64 | [LibreOffice 26.8.3](https://download.documentfoundation.org/libreoffice/stable/26.8.3/win/aarch64/LibreOffice_26.8.3_Win_aarch64.msi.mirrorlist)          | `8ee2ef81ca4103d3eeb06ca9f4ef0b5cbb83357d21d14a449f767bfb29183158` |

上游源码及许可见 [LibreOffice](https://www.libreoffice.org/about-us/licenses/)、[Poppler](https://poppler.freedesktop.org/)、[libheif](https://github.com/strukturag/libheif) 和 [jxrlib](https://github.com/4creators/jxrlib)。Windows 的 LibreOffice 文件从官方 MSI 提取，MSI 同架构的配套运行时 DLL 保留在程序目录。新增的 Python 库保留 PyPI wheel 原始内容及其中的许可。Artifact Tool 的包内许可将使用限定于内部评估和测试，复制或分发需取得 OpenAI 的事先书面许可；这三个平台的新增分片未包含该库。

## Go 服务的 Shell 语法解析器

随附 Go 服务使用 [mvdan/sh v3.14.1](https://github.com/mvdan/sh/tree/v3.14.1) 的 `syntax` 包静态识别 sh/bash 调用形式，不使用其解释执行器。对应 BSD 3-Clause 许可证完整保存在 `resources/runtimes/licenses/mvdan-sh-LICENSE`，随公共许可目录一同保留。

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
