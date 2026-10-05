import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, inspectPatch, restorePatch, sha256 } from '../lib/patch-engine.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-layer-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: 'test' }));
  await fs.mkdir(path.join(root, 'webview'));
  await fs.writeFile(path.join(root, 'webview', 'index.html'), 'official');
  const plan = { adapter: 'test', extensionVersion: 'test', files: [
    { path: 'webview/index.html', originalHash: sha256('official'), content: 'enhanced' },
    { path: 'webview/layer.js', originalHash: null, content: 'addon' },
  ] };
  return { root, plan };
}

test('应用可重复执行，恢复官方原件并删除新增资源', async (t) => {
  const { root, plan } = await fixture(t);
  assert.equal((await applyPatch(root, plan)).status, 'patched');
  assert.equal((await applyPatch(root, plan)).changed, false);
  assert.equal((await restorePatch(root)).changed, true);
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'official');
  assert.equal((await inspectPatch(root)).status, 'original');
  await assert.rejects(fs.access(path.join(root, 'webview/layer.js')));
});

test('未知原件和越界路径在修改前被拒绝', async (t) => {
  const { root, plan } = await fixture(t);
  await assert.rejects(applyPatch(root, { ...plan, files: [{ ...plan.files[0], originalHash: sha256('other') }] }), /预期原件/);
  await assert.rejects(applyPatch(root, { ...plan, files: [{ ...plan.files[0], path: '../outside' }] }), /路径/);
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'official');
  assert.equal((await inspectPatch(root)).status, 'original');
});

test('部分应用的日志可以恢复，不覆盖外部修改', async (t) => {
  const { root, plan } = await fixture(t);
  await applyPatch(root, plan);
  await fs.writeFile(path.join(root, 'webview/index.html'), 'official');
  assert.equal((await inspectPatch(root)).status, 'partial');
  await fs.writeFile(path.join(root, 'webview/layer.js'), 'external');
  await assert.rejects(restorePatch(root), /其他操作修改/);
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'official');
  await fs.writeFile(path.join(root, 'webview/layer.js'), 'addon');
  await restorePatch(root);
});

test('官方更新或备份损坏时不恢复旧文件', async (t) => {
  const { root, plan } = await fixture(t);
  await applyPatch(root, plan);
  await fs.writeFile(path.join(root, '.vscodex-layer/0.original'), 'broken');
  await assert.rejects(restorePatch(root), /备份损坏/);
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'enhanced');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: 'new' }));
  assert.equal((await inspectPatch(root)).status, 'version-changed');
  await assert.rejects(restorePatch(root), /版本已经改变/);
});
