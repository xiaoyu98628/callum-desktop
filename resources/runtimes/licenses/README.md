# 随附资源许可文本

原始发行包中的许可证和 NOTICE 随资源完整保留；macOS ARM64 Python 与技能原生依赖由用户提供的本机环境整理，命令包装器仅调整相对位置与私有临时目录。此处补充固定版本的上游许可文本，尤其用于 macOS 归档未单独携带的 Git COPYING。

| 文件                           | 原始来源                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| git-COPYING                    | [Git v2.56.1 COPYING](https://github.com/git/git/blob/v2.56.1/COPYING)                            |
| git-lfs-LICENSE                | [Git LFS v3.8.1 LICENSE.md](https://github.com/git-lfs/git-lfs/blob/v3.8.1/LICENSE.md)            |
| git-credential-manager-LICENSE | [GCM v2.9.1 LICENSE](https://github.com/git-ecosystem/git-credential-manager/blob/v2.9.1/LICENSE) |
| dugite-native-LICENSE          | [Dugite v2.56.1 LICENSE.md](https://github.com/desktop/dugite-native/blob/v2.56.1/LICENSE.md)     |

原始构建与依赖版本见 [Dugite v2.56.1](https://github.com/desktop/dugite-native/tree/v2.56.1)。除这些公共许可文本外，各发行包内配套依赖的许可证和声明同样保留。安装包资源复制尚未配置；后续分发必须同时包含本目录，具体约定见 [服务程序资源](../../backend/README.md#打包资源约定) 和 [第三方声明](../../../THIRD_PARTY_NOTICES.md)。

`mvdan-sh-LICENSE` 来自 [mvdan/sh v3.14.1 LICENSE](https://github.com/mvdan/sh/blob/v3.14.1/LICENSE)，适用于 Go 服务中仅用于 Shell 静态语法校验的依赖，不属于 Git 归档。
