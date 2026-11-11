# 第三方源码说明

## 随附 Python 与 Node.js

`resources/runtimes/archives/` 保存 Astral python-build-standalone 的完整 Python 发行归档及 Node.js 官方完整发行归档。固定版本、目标架构、上游地址与 SHA-256 见 `resources/runtimes/sources.json`。

上游归档内的许可证和第三方声明原样保留，并随离线解压结果一同提供；其许可范围以相应归档内容为准。这些资源独立于 Electron 内部的 Node.js。资源布局和准备入口见 [桌面端开发](docs/development.md#内置-pythonnode-资源)。

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
