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

适配层使用已安装插件的现有 App Server 连接读取 `thread/list`。导航通过官方 `navigate-to-route` 消息在发起请求的 Webview 打开聊天。前端路由接入点只报告当前路径，不替换官方路由。增强脚本保留官方 VS Code API 的一次获取机制和 `getState`、`setState` 行为，不另起 Codex 进程、不发送聊天消息。

这属于本地增强补丁，不是官方提供的稳定 UI 扩展接口。相关公共文档：[VS Code Webview](https://code.visualstudio.com/api/extension-guides/webview)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 验证

`node --test tests/patch-engine.test.mjs` 检查补丁应用、重复执行、部分恢复、冲突及损坏备份保护。

`node --test tests/host.test.mjs` 使用替身连接检查摘要读取、同面板导航和远程模式拒绝。真实 VS Code 验收需要另行启动窗口，仓库脚本不自动进行。

`node --test tests/bootstrap.test.mjs` 检查官方 API 的一次获取和草稿状态透传。`node tools/check-adapter.mjs` 只读本机官方插件，在临时副本检查接入补丁的语法、应用与恢复。
