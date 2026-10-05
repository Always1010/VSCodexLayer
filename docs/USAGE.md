# 使用与维护

本文件维护安装、恢复、支持边界和官方插件接入点。README 是项目入口。

## 命令

在仓库根目录运行，默认查找当前用户 `.vscode/extensions` 下已适配的官方插件；也可用 `--extension "插件绝对路径"` 指定目录。

```powershell
node tools/layer.mjs status
node tools/layer.mjs plan
node tools/layer.mjs apply --confirm
node tools/layer.mjs restore --confirm
```

`status` 和 `plan` 不修改文件。`apply` 和 `restore` 会修改官方插件安装目录，必须显式加 `--confirm`。关闭所有 VS Code 窗口后应用或恢复，再手动启动 VS Code；打开的 Webview 不会自动热更新。项目脚本不会启动 VS Code 或安装软件。

补丁修改三个官方文件：宿主入口 `out/extension.js`、页面入口 `webview/index.html`、当前版本的前端路由模块。新增一个宿主适配文件和 `webview/vscodex-layer` 下的前端资源，不修改官方聊天数据、账户或系统配置。

原件和校验清单保存在插件目录的 `.vscodex-layer`，同一补丁重复应用不会重复注入。恢复核对当前文件和备份后回写原件、删除新增资源和备份；空的增强资源目录可能保留。恢复不清除聊天历史和导航偏好。

## 兼容与恢复

当前仅支持插件版本 `26.5930.51102` 的已核查 Windows 包，并同时校验三个官方文件的 SHA-256。相同版本但文件内容不同也会拒绝应用。未知版本不会自动修改。

官方更新、其他工具改写文件或备份损坏时，脚本拒绝覆盖。检查 `status` 输出后处理对应版本；不要用旧备份覆盖新插件。若补丁写入中断，保留完整备份并运行恢复命令。进程意外退出可能留下 `.vscodex-layer.lock`，确认没有补丁进程后才能手动移除该锁文件。

## 接入边界

项目按聊天工作目录分组，完整路径区分同名目录。当前工作区没有聊天时仍显示空项目；无法确定目录的聊天放在“未分类”。多根工作区的各根目录均标记为当前项目。“仅当前项目”按规范化后的完整路径精确匹配，不合并子目录或 worktree，也不承诺同步桌面端手动调整的项目归属及所有空项目。聊天列表读取完整分页，不限制为最近 50 条。

点击项目折叠或展开；搜索项目名、路径或聊天标题。搜索期间展开匹配内容。点击聊天只切换右侧官方页面，不改变 VS Code 工作区或聊天原有工作目录。当前聊天由官方路由同步高亮。

顶部图标刷新列表和收起导航；拖动分隔线调整宽度，也可聚焦分隔线后使用左右方向键。列表支持上下、Home、End 移动焦点，项目支持左右方向键折叠与展开。窗口宽度不足 640 像素时导航默认收起，显式操作后记住用户选择。

筛选、折叠状态、宽度及启用状态保存在官方插件的独立命名空间 `vscodexLayer.navigationState.v1`。不占用官方 Webview 的草稿状态。底部返回图标即时恢复原版布局，再用左下角图标启用导航；这不等于卸载文件补丁。列表读取失败时保留已显示内容并显示错误，可刷新重试。

适配层使用已安装插件的现有 App Server 连接读取 `thread/list`。导航通过官方 `navigate-to-route` 消息在发起请求的 Webview 打开聊天。前端路由接入点只报告当前路径，不替换官方路由。增强脚本保留官方 VS Code API 的一次获取机制和 `getState`、`setState` 行为，不另起 Codex 进程、不发送聊天消息。

这属于本地增强补丁，不是官方提供的稳定 UI 扩展接口。相关公共文档：[VS Code Webview](https://code.visualstudio.com/api/extension-guides/webview)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 验证

`node --test tests/patch-engine.test.mjs` 检查补丁应用、重复执行、部分恢复、冲突及损坏备份保护。

`node --test tests/host.test.mjs` 使用替身连接检查摘要读取、同面板导航和远程模式拒绝。真实 VS Code 验收需要另行启动窗口，仓库脚本不自动进行。

`node --test tests/bootstrap.test.mjs` 检查官方 API 的一次获取和草稿状态透传。`node tools/check-adapter.mjs` 只读本机官方插件，在临时副本检查接入补丁的语法、应用与恢复。

`node --test tests/navigation.test.mjs` 检查路径分组、当前项目筛选、搜索和完整分页。相关检查按改动范围运行，不自动启动桌面窗口。

`node tools/check-ui.mjs` 使用本机已有 Chrome 或 Edge 的无头模式，通过模拟官方消息桥接验证导航交互、跨页读取、官方根节点与草稿保留、返回原版以及宽窄布局。不安装浏览器、不弹出窗口，使用临时独立浏览器配置并在退出时清理。模拟界面截图写入被 Git 忽略的 `.scratch/ui`，不能代替真实官方聊天验收。

当前第一版已通过 10 项 Node 检查，以及上述临时副本接入检查和无头界面检查。真实 VS Code 中的流式回复、停止、审批和代码变更查看尚未验证；应用补丁后仍需人工验收。
