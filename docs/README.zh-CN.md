# OpenChamber Kubernetes Explorer

[English](../README.md) | 简体中文 | [العربية](README.ar.md) | [Deutsch](README.de.md) | [Español](README.es.md) | [Français](README.fr.md) | [עברית](README.he.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Nederlands](README.nl.md) | [Polski](README.pl.md) | [Português (Brasil)](README.pt-BR.md) | [Türkçe](README.tr.md) | [Українська](README.uk.md) | [繁體中文](README.zh-TW.md)

为 OpenChamber 提供 Kubernetes 集成。在项目工作区内浏览集群、排查工作负载问题，并执行常用的 Kubernetes 操作。

## 安装

预构建的扩展文件发布到仓库默认分支后：

1. 在 OpenChamber 中打开 **设置 → 扩展**。
2. 将仓库 URL 粘贴到 **文件夹、ZIP 或 URL** 输入框，点击 **添加**：

   ```text
   https://github.com/hlhr202/Openchamber-Kubernetes
   ```

3. 核对并允许扩展请求的本地服务权限，然后从扩展侧栏打开 **Kubernetes**。

无需在本地构建或安装 JavaScript 依赖。仓库为私有时，运行 OpenChamber Server 的环境必须已经具备通过 HTTPS 读取仓库的 Git 凭据。在浏览器里登录 GitHub 不会把凭据提供给服务器。

[通过 Docker 验证的候选版本](status.md)也提供可手动安装的预构建 ZIP。通过 Git URL 安装尚未验证。

## 前置条件

- **OpenChamber 2.5.1**，即本扩展面向的版本。
- 运行 OpenChamber Server 的系统用户能使用有效的 **kubeconfig**、访问 Kubernetes API，并拥有执行所需操作的权限。
- 服务器已安装 **`kubectl`**。调用 Helm CLI 的操作需要 **Helm**。如果 kubeconfig 使用外部凭据助手，服务器也必须具备该工具。扩展不会安装这些工具。

## 功能

- 切换 Kubernetes 上下文和命名空间，在资源树中浏览工作负载、服务和自定义资源。
- 查看资源清单、读取 Pod 日志和查看命名空间事件。
- 检查清单变更，并手动将其应用到所选目标。
- 打开所选容器的终端，或配置端口转发。
- 浏览 Helm 仓库、Chart、Release 和修订历史。

## 作者亲测范围

作者只亲自测试了四种用法：展开资源树中的资源列表、查看资源详情、使用容器终端、配置端口转发。其他用法如有疑问或遇到问题，欢迎[提交 GitHub Issue](https://github.com/hlhr202/Openchamber-Kubernetes/issues)。

## 隐私

- 扩展不会向开发者发送遥测或分析数据。它使用服务器上的 kubeconfig，按你已有的权限连接所配置的 Kubernetes API。
- 获取的资源数据、日志、终端输出和未保存的草稿只保存在内存中，不会写入磁盘。扩展会保存 kubeconfig 来源选择等非敏感偏好，但不保存 kubeconfig 内容。手动保存或导出是独立操作。
- Secret 值仅在你明确请求且拥有 Kubernetes 权限时显示。集群数据不会自动发送到聊天或模型提供商。

本声明仅适用于此扩展，不适用于 OpenChamber、Kubernetes 或你使用的其他工具和服务。

## 许可证

[MIT](../LICENSE)。随包分发的依赖保留各自的许可证，详见预构建包中的 `THIRD_PARTY_NOTICES.txt`。

[项目文档](README.md) · [产品范围](product.md) · [开发文档](development.md)
