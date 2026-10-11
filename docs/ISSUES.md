# 问题日志

记录已确认的项目缺陷及其处理，不收录普通功能需求和本机开发环境问题。

## ISSUE-001：已应用补丁的目标无法再次进行接入检查

- 日期：2026-10-06
- 状态：已解决
- 现象：接入检查工具以已应用补丁的插件目录为输入时，复制修改后的官方文件到验证副本，随后原件校验失败；应用补丁后无法重复使用该检查工具。
- 原因：验证副本通过 `copyFile` 从当前目标读取官方文件，未区分当前文件与补丁备份中的原件。
- 解决方案：统一使用 `readOriginal` 按原件 SHA-256 读取当前原件或受校验的备份，并支持显式指定检查目录。
- 验证：在临时插件副本应用完整补丁后，以该副本为输入运行接入检查；副本内应用、重复应用、语法和恢复检查均通过。实际安装的官方插件未修改。
- 相关文件：`tools/check-adapter.mjs`、`lib/patch-engine.mjs`、`docs/USAGE.md`。

## ISSUE-002：兼容补丁应用后宿主层无法初始化

- 日期：2026-10-07
- 状态：已解决
- 现象：`26.51002.51308` 通过结构兼容探测、应用和语法检查，但启动 VS Code 后没有显示项目导航；Codex 日志记录 `VSCodexLayer host unavailable`。
- 原因：兼容适配器动态捕获了前端压缩变量，却在宿主注入代码中仍写死旧构建的 VS Code API 命名空间 `Ge` 和 WSL 判断函数 `Wr`。新版实际 VS Code API 命名空间为 `je`，初始化时立即失败；仅检查语法无法发现这一运行时引用错误。
- 解决方案：从 Webview 初始化函数已有的 `Uri.joinPath(this.extensionUri, "webview")` 调用动态捕获 VS Code API 命名空间，从官方 WSL 配置判断结构动态捕获运行模式函数，保留 Windows 本地窗口使用 WSL 后端时的拒绝行为；初始化失败时记录实际异常。
- 验证：对当前 `26.51002.51308` 原件生成兼容补丁，在隔离环境实际执行宿主注入入口及初始化消息，验证本地支持、WSL 后端拒绝、远程 WSL 拒绝和错误日志；在临时副本完成语法、应用、重复应用和恢复检查。
- 相关文件：`adapters/codex-compatible.mjs`、`tools/check-compatible.mjs`。

## ISSUE-003：Linux 项目草稿和导航路径可能被合并

- 日期：2026-10-11
- 状态：已解决
- 现象：Linux 上 `/home/ubuntu/Project` 与 `/home/ubuntu/project` 生成相同的项目草稿键；目录名含反斜线或尾部空格时，导航可能误合并不同目录。
- 原因：草稿键一律转换成小写及替换反斜线，导航路径一律替换反斜线并去除首尾空格，沿用了 Windows 路径假设。
- 解决方案：按路径类型处理，Linux 草稿键保留大小写和合法字符，导航保留反斜线及尾部空格；Windows 草稿键继续使用原有规则，首页／面板草稿仍独立。
- 验证：bootstrap 和导航测试覆盖大小写不同目录、反斜线与目录分隔符、尾部空格、根目录及首页／面板隔离；Linux ARM64 插件临时副本验证生成补丁、语法、重复应用和恢复。真实 Remote SSH 界面验收待进行。
- 相关文件：`webview/bootstrap.js`、`webview/core.mjs`、`tests/bootstrap.test.mjs`、`tests/navigation.test.mjs`、`docs/USAGE.md`。

## ISSUE-004：Remote SSH 工作区被误判为不支持

- 日期：2026-10-11
- 状态：已解决（已更新远程插件补丁）
- 现象：Linux ARM64 官方插件补丁已应用且结构检查通过，但真实 Remote SSH 工作区无法启用项目导航。
- 原因：宿主检查错误地要求工作区 URI 为 `vscode-remote:` 并携带 SSH authority；已安装 VS Code Server 的 URI 转换器会先将 SSH URI 转为无 authority 的 `file:` URI 再传给远程扩展。原模拟检查沿用了客户端 URI，遗漏真实宿主形态。
- 解决方案：在 Linux Workspace 扩展及插件目录身份检查通过后，接受当前宿主的绝对 `file:` 目录；拒绝客户端 `vscode-local:`、虚拟 URI、非空 authority 和相对路径。接入检查同步使用真实远程宿主 URI。
- 验证：4 项宿主回归测试及当前 Linux ARM64 插件临时副本接入检查通过；提取已安装 VS Code Server 的真实 URI 转换器后执行同一初始化请求，旧补丁返回 `supported: false`，仓库修复返回 `supported: true`。用户关闭 VS Code 并授权后，已更新远程 `26.51007.21434-linux-arm64` 插件补丁；11 个补丁文件与当前计划一致，已安装宿主初始化返回 `supported: true`、`mode: ssh-remote`。真实窗口验收待重新连接后进行。
- 相关文件：`runtime/host.cjs`、`tests/host.test.mjs`、`tools/check-compatible.mjs`、`docs/USAGE.md`。

## ISSUE-005：项目聊天首条消息触发扩展不支持的无项目目录分配

- 日期：2026-10-11
- 状态：已解决（已更新远程插件补丁）
- 现象：点击项目行的 `＋` 后发送第一条消息，线程已创建，但发送报错 `projectless-thread-cwd not supported in extension`。
- 原因：目录草稿没有桌面项目编号，官方创建参数生成了 `projectAssignment: null`。当前官方归属保存回调将空归属登记为无项目线程，首次消息的工作区选择随后尝试调用仅桌面端支持的目录分配接口。此前接入检查截停在创建请求前，未覆盖归属保存和首次消息工作区判断。
- 解决方案：仅对携带 `vclProjectCwd` 的目录草稿，将创建参数的 `projectAssignment` 留为 `undefined`，跳过桌面项目归属保存，保留经过校验的目录、工作区根及原生消息发送；普通聊天和桌面无项目线程保持官方行为。
- 验证：当前 `26.51007.21434-linux-arm64` 的隔离检查执行官方 Composer、参数转换、真实归属回调及首次消息工作区判断；旧逻辑复现同一报错，修复后三个不同目录的首次消息准备通过，目录失效时不创建线程。语法、临时副本应用、重复应用和恢复通过。用户关闭 VS Code 并授权后已更新实际远程插件，11 个补丁文件与修复计划一致，直接读取已安装代码执行首次消息准备检查通过；真实窗口发送待重新连接后验证。Windows 严格模式同步使用同一转换，当前环境仅完成语法检查。已创建失败线程的历史和归属不自动改写，修复后通过项目 `＋` 新建聊天验证。
- 相关文件：`adapters/codex-compatible.mjs`、`adapters/codex-26.5930.51102.mjs`、`tools/native-project-submit.mjs`、`tools/check-compatible.mjs`、`tools/check-adapter.mjs`、`docs/USAGE.md`。
