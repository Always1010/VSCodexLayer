import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPatch, inspectPatch, restorePatch, validatePlan } from '../lib/patch-engine.mjs';
import { probeCompatibility } from '../lib/compatibility.mjs';
import { findInstalledExtension } from '../lib/extension-discovery.mjs';
import { buildCompatiblePatchPlan } from '../adapters/codex-compatible.mjs';
import { buildPatchPlan, VERSION } from '../adapters/codex-26.5930.51102.mjs';

export async function findExtension() {
  return (await findInstalledExtension()).root;
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'status';
  if (command === 'help' || command === '--help') {
    console.log('node tools/layer.mjs <status|probe|plan|apply|restore> [--compatible] [--extension 路径] [--confirm]\n'
      + 'status / probe / plan 只读；apply 安装或更新补丁，自动校验并恢复旧补丁；restore 卸载补丁。\n'
      + '--compatible 按结构检查未知版本；apply / restore 修改官方插件文件，必须显式加 --confirm。');
    return;
  }
  if (!['status', 'probe', 'plan', 'apply', 'restore'].includes(command)) throw new Error('未知命令。运行 help 查看用法。');
  let directory;
  let confirm = false;
  let compatible = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--confirm') confirm = true;
    else if (args[index] === '--compatible') compatible = true;
    else if (args[index] === '--extension' && args[index + 1]) directory = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (['apply', 'restore'].includes(command) && !confirm) throw new Error('本命令会修改官方插件文件；确认目标后添加 --confirm。');
  directory ??= await findExtension();
  let result;
  if (command === 'status') result = await inspectPatch(directory);
  else if (command === 'probe') {
    result = await probeCompatibility(directory, VERSION);
    try {
      const plan = await buildCompatiblePatchPlan(directory);
      result = { ...result, compatible: true, family: plan.compatibility.family,
        selected: plan.compatibility, changes: plan.files.map((entry) => entry.path) };
    } catch (error) { result = { ...result, compatible: false, reason: error.message }; }
    result = { ...result, patchCompatible: result.compatible, runtimeSupport: {
      verified: false,
      modes: ['local', 'ssh-remote'],
      requirement: 'SSH 模式要求 Codex 扩展运行在远程 Linux 工作区宿主，工作区属于同一 SSH 主机；WSL 和其他远程模式暂不支持。',
      note: 'compatible / patchCompatible 仅表示补丁结构兼容；实际运行支持由 VS Code 内的宿主初始化检查。',
    } };
  }
  else if (command === 'restore') result = await restorePatch(directory);
  else {
    const plan = compatible ? await buildCompatiblePatchPlan(directory) : await buildPatchPlan(directory);
    if (command === 'apply') result = await applyPatch(directory, plan);
    else {
      const state = await inspectPatch(directory);
      if (state.status === 'original') await validatePlan(directory, plan);
      else if (state.status !== 'patched') throw new Error(`当前状态为 ${state.status}，请先检查备份和冲突。`);
      result = { ...state, compatible: true, compatibility: plan.compatibility, changes: plan.files.map((entry) => ({
        path: entry.path, action: entry.originalHash === null ? 'add' : 'patch',
      })) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
