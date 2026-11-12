# Python/Node/Git 离线解压目录

本说明文件随 Git 保存，用于保留目录并说明资源位置。各平台解压结果及临时文件由 Git 忽略，不重复提交。

从仓库根目录执行以下命令，使用 `resources/runtimes/archives/` 中的完整归档离线准备当前平台资源，无需手动放置文件：

```sh
npm run prepare:runtimes
```

`npm run dev`、`npm run build` 和 `npm test` 会自动执行该准备步骤。添加 `-- --all` 可准备全部四个平台。

生成布局如下，每个平台目录包含完整 Python、Node、Git 和完整性清单：

```text
unpacked/
  README.md
  darwin-arm64/
  darwin-x64/
  win32-x64/
  win32-arm64/

<平台>/
  python/
  node/
  git/
  manifest.json
```

Go 服务实际执行对应平台目录中的 Python、Node 和 Git。完整资源来源、校验与维护方式见 [内置 Python/Node/Git 资源](../../../docs/development.md#内置-pythonnodegit-资源)。

清单内部的 `format_version: 2` 仅用于格式校验，不加入目录。已有旧格式或损坏缓存时，准备命令仍拒绝覆盖；请在服务关闭后先备份原目录，再用已经校验的新资源替换。
