import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { findExtension } from './layer.mjs';
import { buildPatchPlan } from '../adapters/codex-26.5930.51102.mjs';
import { applyPatch, restorePatch, sha256 } from '../lib/patch-engine.mjs';

// Only read the real installation. Exercise mutations in a newly created fixture.
const directory = await findExtension();
const plan = await buildPatchPlan(directory);
new Script(plan.files.find((entry) => entry.path === 'out/extension.js').content);
const temporaryParent = await fs.realpath(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(temporaryParent, 'vscodex-layer-adapter-'));
if (!fixture.startsWith(`${temporaryParent}${path.sep}vscodex-layer-adapter-`)) throw new Error('临时验证目录异常。');
try {
  await fs.copyFile(path.join(directory, 'package.json'), path.join(fixture, 'package.json'));
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    const target = path.join(fixture, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(directory, entry.path), target);
  }
  const result = await applyPatch(fixture, plan);
  if (result.status !== 'patched') throw new Error('补丁未完整应用。');
  if ((await applyPatch(fixture, await buildPatchPlan(fixture))).changed) throw new Error('重复应用未保持幂等。');
  for (const entry of plan.files.filter((file) => /\.(mjs|cjs|js)$/.test(file.path))) {
    // A .mjs copy lets Node parse the official ESM chunk without loading its imports.
    const checkFile = path.join(fixture, entry.path.endsWith('.cjs') ? 'syntax.cjs' : 'syntax.mjs');
    await fs.writeFile(checkFile, entry.content);
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe', windowsHide: true });
  }
  await restorePatch(fixture);
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    if (sha256(await fs.readFile(path.join(fixture, entry.path))) !== entry.originalHash) throw new Error(`恢复后校验失败：${entry.path}`);
  }
  console.log(`官方 ${plan.extensionVersion} 接入校验通过：临时副本应用、重复应用、恢复及 JavaScript 语法。实际插件未修改。`);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
