# Python/Node/Git 与技能依赖解压目录

本说明随 Git 保存。平台解压结果及临时文件由 Git 忽略，不重复提交。

在客户端仓库执行 `npm run prepare:runtimes`，从 `resources/runtimes/archives/` 离线准备当前平台；添加 `-- --all` 准备全部平台。开发、构建、测试会自动执行准备步骤。

每个平台目录包含 `python/`、`node/`、`git/`、`native/` 和 `manifest.json`。`native/` 提供 LibreOffice、Poppler、HEIF 和 JPEG XR 转换工具。Windows 的 `native-executables.json` 指向同一目录内的真实可执行文件。Python 库与通用解释器合并。技能正文、脚本和参考资料由 `resources/skills/.system/` 持有，客户端初始化时复制到实际数据目录的 `skills/.system/`，运行时安装到同级 `runtimes/` 后才执行；Go 服务不内嵌技能包。

清单 `format_version: 3` 只用于格式校验。已有缓存不一致时拒绝覆盖；应在独立目录核验，并在服务关闭后备份和替换生成资源。详情见 [运行时资源准备](../../../docs/development.md#内置-pythonnodegit-资源)。
