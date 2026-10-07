import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyPatch, inspectPatch, readUnpatched, restorePatch, sha256 } from '../lib/patch-engine.mjs';

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

test('已应用补丁时可以安全读取受校验的官方原件', async (t) => {
  const { root, plan } = await fixture(t);
  await applyPatch(root, plan);
  assert.equal((await readUnpatched(root, 'webview/index.html')).toString(), 'official');
  await fs.writeFile(path.join(root, 'webview/index.html'), 'external');
  await assert.rejects(readUnpatched(root, 'webview/index.html'), /其他操作修改/);
});

test('直接应用当前代码可更新旧补丁，文件增减后仍能恢复官方原件', async (t) => {
  const { root, plan } = await fixture(t);
  await applyPatch(root, plan);
  const updated = { ...plan, files: plan.files.map((entry) => ({ ...entry, content: `${entry.content}-new` })) };
  assert.equal((await applyPatch(root, updated)).changed, true);
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'enhanced-new');
  assert.equal(await fs.readFile(path.join(root, 'webview/layer.js'), 'utf8'), 'addon-new');
  assert.equal(await fs.readFile(path.join(root, '.vscodex-layer/0.original'), 'utf8'), 'official');
  assert.equal((await applyPatch(root, updated)).changed, false);

  await fs.writeFile(path.join(root, 'webview/other.html'), 'other-official');
  const next = { ...updated, adapter: 'test-v2', files: [
    { path: 'webview/other.html', originalHash: sha256('other-official'), content: 'other-enhanced' },
    { path: 'webview/new.js', originalHash: null, content: 'new-addon' },
  ] };
  assert.equal((await applyPatch(root, next)).status, 'patched');
  assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'official');
  await assert.rejects(fs.access(path.join(root, 'webview/layer.js')));
  assert.equal(await fs.readFile(path.join(root, 'webview/other.html'), 'utf8'), 'other-enhanced');
  assert.equal(await fs.readFile(path.join(root, 'webview/new.js'), 'utf8'), 'new-addon');
  await restorePatch(root);
  assert.equal(await fs.readFile(path.join(root, 'webview/other.html'), 'utf8'), 'other-official');
  await assert.rejects(fs.access(path.join(root, 'webview/new.js')));
  assert.equal((await inspectPatch(root)).status, 'original');
});

test('自动更新在校验失败时保留已有补丁和备份', async (t) => {
  const cases = [
    ['旧文件冲突', async (root) => fs.writeFile(path.join(root, 'webview/layer.js'), 'external'), /conflict/],
    ['备份损坏', async (root) => fs.writeFile(path.join(root, '.vscodex-layer/0.original'), 'broken'), /备份损坏/],
    ['备份缺失', async (root) => fs.unlink(path.join(root, '.vscodex-layer/0.original')), /备份缺失/],
    ['新资源冲突', async (root, next) => {
      await fs.writeFile(path.join(root, 'webview/new.js'), 'external');
      next.files.push({ path: 'webview/new.js', originalHash: null, content: 'new-addon' });
    }, /预期原件/],
    ['错误原件', async (_root, next) => { next.files[0].originalHash = sha256('other'); }, /预期原件/],
    ['版本变更', async (root) => fs.writeFile(path.join(root, 'package.json'),
      JSON.stringify({ name: 'chatgpt', publisher: 'openai', version: 'new' })), /version-changed/],
    ['未完成操作', async (root) => fs.unlink(path.join(root, 'webview/layer.js')), /partial/],
  ];
  for (const [name, prepare, message] of cases) {
    await t.test(name, async (subtest) => {
      const { root, plan } = await fixture(subtest);
      await applyPatch(root, plan);
      const next = { ...plan, files: plan.files.map((entry) => ({ ...entry, content: `${entry.content}-new` })) };
      await prepare(root, next);
      const manifestFile = path.join(root, '.vscodex-layer/manifest.json');
      const manifest = await fs.readFile(manifestFile, 'utf8');
      await assert.rejects(applyPatch(root, next), message);
      assert.equal(await fs.readFile(path.join(root, 'webview/index.html'), 'utf8'), 'enhanced');
      assert.equal(await fs.readFile(manifestFile, 'utf8'), manifest);
      // A failed preflight also releases the shared operation lock.
      await assert.rejects(fs.access(path.join(root, '.vscodex-layer.lock')));
    });
  }
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
