# VSCodexLayer

为官方 Codex VS Code 插件增加项目聊天导航，保留官方聊天界面和后端连接。

需要已有 Node.js 22 或更新版本，无需安装 npm 依赖。第一版适配 Windows 本地工作区和 Codex 插件 `26.5930.51102`。

```powershell
node tools/layer.mjs status
node tools/layer.mjs probe
node tools/layer.mjs plan
```

这些命令只读。`probe` 检查当前实际启用的官方插件及兼容接入点。应用及恢复方法、支持范围和接入说明见 [使用与维护](docs/USAGE.md)。

主要功能：项目分组与折叠、全部／当前项目筛选、项目和聊天搜索、按项目目录新建聊天与独立草稿保留、同面板切换官方聊天、导航宽度调整，以及可恢复的补丁应用。

已确认问题的原因、修复和验证记录见 [问题日志](docs/ISSUES.md)。
