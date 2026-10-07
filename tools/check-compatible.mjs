import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCompatiblePatchPlan } from '../adapters/codex-compatible.mjs';
import { applyPatch, readUnpatched, restorePatch, sha256 } from '../lib/patch-engine.mjs';
import { findExtension } from './layer.mjs';

const args = process.argv.slice(2);
if (args.length && (args[0] !== '--extension' || args.length !== 2)) {
  throw new Error('用法：node tools/check-compatible.mjs [--extension 路径]');
}
const directory = args[1] ?? await findExtension();
const plan = await buildCompatiblePatchPlan(directory);
const byPath = (relative) => plan.files.find((entry) => entry.path === relative)?.content.toString();
const route = byPath(plan.compatibility.route);
const composer = byPath(plan.compatibility.composer);
const header = byPath(plan.compatibility.header);
const host = byPath('out/extension.js');
const hostNamespace = /require\(([A-Za-z_$][\w$]*)\.Uri\.joinPath\([^)]*"vscodex-layer-host\.cjs"[^)]*\)[\s\S]{0,240}?createLayerHost\(\{vscode:\1,/.exec(host);
assert.ok(hostNamespace, '宿主注入必须复用当前构建的 VS Code API 命名空间');
assert.match(host, new RegExp(`isWsl:\\(\\)=>${hostNamespace[1]}\\.env\\.remoteName===\"wsl\"`));
assert.equal((route.match(/projectRoute\(/g) ?? []).length, 1);
assert.equal((route.match(/vclDraftKey/g) ?? []).length, 13);
assert.equal((composer.match(/projectCwd\(/g) ?? []).length, 5);
assert.equal((composer.match(/validateProject\(/g) ?? []).length, 1);
assert.equal((header.match(/data-vcl-home-history/g) ?? []).length, 2);
assert.equal((header.match(/data-vcl-chat-back/g) ?? []).length, 1);

const temporaryParent = await fs.realpath(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(temporaryParent, 'vscodex-layer-compatible-'));
if (!fixture.startsWith(`${temporaryParent}${path.sep}vscodex-layer-compatible-`)) throw new Error('临时验证目录异常。');
try {
  await fs.copyFile(path.join(directory, 'package.json'), path.join(fixture, 'package.json'));
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    const target = path.join(fixture, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readUnpatched(directory, entry.path));
  }
  const result = await applyPatch(fixture, plan);
  assert.equal(result.status, 'patched');
  const rebuilt = await buildCompatiblePatchPlan(fixture);
  assert.equal((await applyPatch(fixture, rebuilt)).changed, false);
  for (const entry of plan.files.filter((file) => /\.(mjs|cjs|js)$/.test(file.path))) {
    const checkFile = path.join(fixture, entry.path.endsWith('.cjs') ? 'syntax.cjs' : 'syntax.mjs');
    await fs.writeFile(checkFile, entry.content);
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe', windowsHide: true });
  }
  await restorePatch(fixture);
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    assert.equal(sha256(await fs.readFile(path.join(fixture, entry.path))), entry.originalHash);
  }
  console.log(`官方 ${plan.extensionVersion} 兼容结构校验通过：${plan.compatibility.family}；动态资源、转换完整性、语法、临时副本应用、重复应用和恢复均通过。实际插件未修改。`);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
