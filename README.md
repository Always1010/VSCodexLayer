# VSCodexLayer

VSCodexLayer 是官方 Codex VS Code 插件的本地增强补丁，让你更方便地按项目管理聊天、查看推理摘要。聊天和消息发送仍由官方插件处理。

## 主要功能

- **按项目整理聊天**：项目分组、折叠、置顶，搜索项目或聊天，也可以只看当前项目。
- **管理聊天记录**：归档、查找和恢复聊天，支持批量归档，也能删除聊天。
- **在指定项目中新建聊天**：每个项目保留自己的未发送草稿，切换聊天时可以继续编辑。
- **查看进展**：显示运行状态和未读提醒，展开查看官方返回的推理摘要。
- **查看子 Agent**：查看子 Agent（子任务助手）的数量、任务、状态和聊天详情。

## 怎么开始

先安装官方 Codex VS Code 插件，并准备好 Node.js 22 或更新版本。本项目无需运行 `npm install`。

在本仓库目录打开终端，先检查插件状态和兼容性：

```powershell
node tools/layer.mjs status
node tools/layer.mjs probe
```

这两条命令只做检查，不修改文件。确认兼容后，关闭所有 VS Code 窗口，在独立终端中运行以下命令启用增强功能，再重新打开 VS Code：

```powershell
node tools/layer.mjs apply --compatible --confirm
```

该命令会修改官方插件文件，并备份原文件。支持本地工作区，以及 Codex 插件运行在远程 Linux 主机上的 Remote SSH 工作区；使用 Remote SSH 时，以上命令应在远程主机上运行。

## 更多说明

- [使用与维护](docs/USAGE.md)：详细操作、支持版本、Remote SSH 设置、更新和卸载方法。
- [问题日志](docs/ISSUES.md)：已确认问题的原因、处理状态和验证记录。
