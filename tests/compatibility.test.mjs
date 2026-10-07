import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { probeCompatibility } from '../lib/compatibility.mjs';
import { findInstalledExtension } from '../lib/extension-discovery.mjs';

async function extension(parent, version, files = {}) {
  const root = path.join(parent, `openai.chatgpt-${version}-win32-x64`);
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.mkdir(path.join(root, 'webview', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'openai', version }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test('发现当前未过期的最高版本而不选择残留目录', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-discovery-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await extension(parent, '26.5930.51102');
  const current = await extension(parent, '26.51002.51308');
  await extension(parent, '26.6000.10000');
  await fs.writeFile(path.join(parent, '.obsolete'), JSON.stringify({
    'openai.chatgpt-26.5930.51102': true,
    'openai.chatgpt-26.6000.10000': true,
  }));
  const result = await findInstalledExtension(parent);
  assert.equal(result.root, current);
  assert.equal(result.version, '26.51002.51308');
  assert.equal(result.candidates.length, 3);
});

test('只读探测报告动态入口和语义候选文件', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-probe-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = await extension(parent, 'future', {
    'out/extension.js': 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),rest',
    'webview/index.html': '<script type="module" src="./assets/index-new.js"></script>',
    'webview/assets/app-initial-route.js': 'navigate-to-route /extension/panel/new routeTemplate',
    'webview/assets/app-initial-composer.js': 'activeWorkspaceRoot selectedRemoteProject workspaceRoots',
    'webview/assets/header-new.js': 'header.recentChats tasksQuery',
  });
  const result = await probeCompatibility(root, 'supported');
  assert.equal(result.mode, 'unknown-version');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.discovered.moduleEntries, ['./assets/index-new.js']);
  assert.deepEqual(result.discovered.routeCandidates, ['app-initial-route.js']);
  assert.deepEqual(result.discovered.composerCandidates, ['app-initial-composer.js']);
  assert.deepEqual(result.discovered.headerCandidates, ['header-new.js']);
  assert.ok(Object.values(result.checks).every(Boolean));
});
