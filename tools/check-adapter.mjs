import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script, createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findExtension } from './layer.mjs';
import { buildPatchPlan, DRAFT_SOURCE } from '../adapters/codex-26.5930.51102.mjs';
import { applyPatch, restorePatch, sha256, readOriginal } from '../lib/patch-engine.mjs';

// Only read the real installation. Exercise mutations in a newly created fixture.
const args = process.argv.slice(2);
if (args.length && (args[0] !== '--extension' || args.length !== 2)) throw new Error('用法：node tools/check-adapter.mjs [--extension 路径]');
const directory = args[1] ?? await findExtension();
const plan = await buildPatchPlan(directory);
new Script(plan.files.find((entry) => entry.path === 'out/extension.js').content);
// Exercise the exact supported native draft functions without importing the app or opening VS Code.
const composerSource = (await readOriginal(directory, ...DRAFT_SOURCE)).toString('utf8');
const routeSource = plan.files.find((entry) => entry.path === 'webview/assets/app-initial-3a0869cff48f.js').content;
const functionSource = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('}function ', start);
  if (start < 0 || end < 0) throw new Error(`官方草稿接入点缺失：${name}`);
  return source.slice(start, end + 1);
};
const storage = new Map();
const draftAtom = Symbol('native-draft');
const harness = createContext({
  globalThis: { __vscodexLayerBridge: { resumeDraft: () => true } },
  wd: ({ entrypoint }) => `native-new:${entrypoint}`, Sp: undefined,
  eG: (prompt) => typeof prompt === 'string' ? prompt : prompt?.text ?? '',
  crr: () => false, Rnr: () => {}, ug: (id) => `local:${id}`,
  cG: Symbol(), mG: draftAtom, ZU: Symbol(), Brr: Symbol(),
  Wnr: () => {}, fke: () => {}, WW: () => {},
  rG: { setDraft(_scope, keys, draft) { for (const key of keys) draft === undefined ? storage.delete(key) : storage.set(key, draft); } },
});
runInContext(functionSource(routeSource, 'ey') + ';Sp=ey;' +
  ['irr', 'QW', 'arr', 'Gnr'].map((name) => functionSource(composerSource, name)).join(';') +
  ';' + functionSource(routeSource, 'KV'), harness);
const scope = (value) => ({ value, get: () => storage.get(harness.ey(value)), set() {} });
for (const entrypoint of ['home', 'panel']) {
  const value = { kind: 'new', entrypoint };
  const text = `未发送的中文草稿\n第二行 @文件 /命令 ${entrypoint}`;
  harness.irr(scope(value), text);
  const other = { kind: 'local', clientThreadId: 'local:existing', conversationId: 'existing' };
  harness.irr(scope(other), '历史聊天自己的草稿');
  // Plain new-chat takes the enhancement's route-only path, never the native composer-reset path.
  harness.KV(scope(other), { selectChat: true });
  assert.equal(scope(value).get(draftAtom).prompt, text);
  assert.equal(scope(other).get(draftAtom).prompt, '历史聊天自己的草稿');
  const rich = { text, document: { content: [{ type: 'fileMention', path: 'D:/文件.md' }] } };
  harness.irr(scope(value), rich);
  assert.equal(scope(value).get(draftAtom).prompt, rich, '结构化草稿必须保留原对象');
  harness.Gnr(scope(value));
  assert.equal(scope(value).get(draftAtom), undefined, '官方提交清理后不能复活已发送草稿');
  assert.equal(scope(other).get(draftAtom).prompt, '历史聊天自己的草稿');
}
const temporaryParent = await fs.realpath(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(temporaryParent, 'vscodex-layer-adapter-'));
if (!fixture.startsWith(`${temporaryParent}${path.sep}vscodex-layer-adapter-`)) throw new Error('临时验证目录异常。');
try {
  await fs.copyFile(path.join(directory, 'package.json'), path.join(fixture, 'package.json'));
  const dependency = path.join(fixture, DRAFT_SOURCE[0]);
  await fs.mkdir(path.dirname(dependency), { recursive: true });
  await fs.writeFile(dependency, composerSource);
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    const target = path.join(fixture, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readOriginal(directory, entry.path, entry.originalHash));
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
  console.log(`官方 ${plan.extensionVersion} 接入校验通过：原生首页/面板草稿隔离、结构化草稿保留、提交清理，以及临时副本应用、重复应用、恢复和语法。实际插件未修改。`);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
