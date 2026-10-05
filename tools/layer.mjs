import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPatch, inspectPatch, restorePatch, validatePlan } from '../lib/patch-engine.mjs';
import { buildPatchPlan, VERSION } from '../adapters/codex-26.5930.51102.mjs';

export async function findExtension() {
  const parent = path.join(os.homedir(), '.vscode', 'extensions');
  const candidates = (await fs.readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name === `openai.chatgpt-${VERSION}-win32-x64`);
  if (candidates.length !== 1) throw new Error(`未唯一找到已适配的插件。请使用 --extension 指定 Codex ${VERSION} 的安装目录。`);
  return path.join(parent, candidates[0].name);
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? 'status';
  if (command === 'help' || command === '--help') {
    console.log('node tools/layer.mjs <status|plan|apply|restore> [--extension 路径] [--confirm]\n'
      + 'status / plan 只读；apply 安装或更新补丁，自动校验并恢复旧补丁；restore 卸载补丁。\n'
      + 'apply / restore 修改官方插件文件，必须显式加 --confirm。');
    return;
  }
  if (!['status', 'plan', 'apply', 'restore'].includes(command)) throw new Error('未知命令。运行 help 查看用法。');
  let directory;
  let confirm = false;
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--confirm') confirm = true;
    else if (args[index] === '--extension' && args[index + 1]) directory = args[++index];
    else throw new Error(`未知参数：${args[index]}`);
  }
  if (['apply', 'restore'].includes(command) && !confirm) throw new Error('本命令会修改官方插件文件；确认目标后添加 --confirm。');
  directory ??= await findExtension();
  let result;
  if (command === 'status') result = await inspectPatch(directory);
  else if (command === 'restore') result = await restorePatch(directory);
  else {
    const plan = await buildPatchPlan(directory);
    if (command === 'apply') result = await applyPatch(directory, plan);
    else {
      const state = await inspectPatch(directory);
      if (state.status === 'original') await validatePlan(directory, plan);
      else if (state.status !== 'patched') throw new Error(`当前状态为 ${state.status}，请先检查备份和冲突。`);
      result = { ...state, compatible: true, changes: plan.files.map((entry) => ({
        path: entry.path, action: entry.originalHash === null ? 'add' : 'patch',
      })) };
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
