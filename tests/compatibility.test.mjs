import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { probeCompatibility } from '../lib/compatibility.mjs';
import { findInstalledExtension } from '../lib/extension-discovery.mjs';
import { findExtension } from '../tools/layer.mjs';
import { patchReasoningActivity, patchReasoningRenderer, patchReadTarget } from '../adapters/reasoning.mjs';

async function extension(parent, version, files = {}, platform = 'win32-x64') {
  const root = path.join(parent, `openai.chatgpt-${version}-${platform}`);
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
  const result = await findInstalledExtension(parent, { platform: 'win32-x64' });
  assert.equal(result.root, current);
  assert.equal(result.version, '26.51002.51308');
  assert.equal(result.candidates.length, 3);
});

test('ARM64 发现遵循安装清单、平台和过期标记，多个宿主拒绝猜测', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-arm64-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const remote = path.join(home, '.vscode-server', 'extensions');
  const current = await extension(remote, '26.51007.21434', {}, 'linux-arm64');
  await extension(remote, '99.1.0', {}, 'linux-arm64');
  await extension(remote, '99.2.0', {}, 'win32-x64');
  const old = await extension(remote, '99.3.0', {}, 'linux-arm64');
  const record = (root, version) => ({ identifier: { id: 'openai.chatgpt' }, version,
    relativeLocation: path.basename(root), metadata: { targetPlatform: 'linux-arm64' } });
  await fs.writeFile(path.join(remote, 'extensions.json'), JSON.stringify([
    record(current, '26.51007.21434'), record(old, '99.3.0'),
  ]));
  await fs.writeFile(path.join(remote, '.obsolete'), JSON.stringify({ [path.basename(old)]: true }));
  const options = { home, platform: 'linux-arm64' };
  assert.equal((await findInstalledExtension(undefined, options)).root, current);
  const local = path.join(home, '.vscode', 'extensions');
  await extension(local, '26.51007.21434', {}, 'linux-arm64');
  await assert.rejects(findInstalledExtension(undefined, options), /无法确定当前宿主/);
  assert.equal((await findInstalledExtension(remote, options)).root, current);
  await fs.writeFile(path.join(remote, 'extensions.json'), '[]');
  await assert.rejects(findInstalledExtension(remote, options), /未找到/);
});

test('终端选择宿主只使用各目录当前版本，取消及非交互环境不猜测目标', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-selection-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, platform: 'linux-arm64' };
  const remoteParent = path.join(home, '.vscode-server', 'extensions');
  const remote = await extension(remoteParent, '26.2.0', {}, options.platform);
  // 单目录及显式目录不应进入选择器。
  assert.equal((await findInstalledExtension(undefined, { ...options, select: () => assert.fail('不应询问') })).root, remote);
  await extension(remoteParent, '26.1.0', {}, options.platform);
  const obsolete = await extension(remoteParent, '99.0.0', {}, options.platform);
  await fs.writeFile(path.join(remoteParent, '.obsolete'), JSON.stringify({ [path.basename(obsolete)]: true }));
  const local = await extension(path.join(home, '.vscode', 'extensions'), '26.3.0', {}, options.platform);
  assert.equal((await findInstalledExtension(remoteParent, { ...options, select: () => assert.fail('不应询问') })).root, remote);
  await assert.rejects(findInstalledExtension(undefined, { ...options, select: () => ({ root: obsolete }) }), /未选择有效/);

  async function choose(answer, tty = true) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = tty;
    let menu = '';
    output.on('data', (chunk) => { menu += chunk; });
    const result = findExtension({ ...options, input, output });
    // 异步送入模拟终端输入；发现目录期间由流保留输入。
    const send = setImmediate(() => input.end(answer));
    try { return { root: await result, menu }; }
    finally { clearImmediate(send); input.destroy(); output.destroy(); }
  }
  const selectedRemote = await choose('1\n');
  assert.equal(selectedRemote.root, remote);
  assert.match(selectedRemote.menu, /VS Code Server（Remote SSH）/);
  assert.match(selectedRemote.menu, /本机桌面 VS Code/);
  assert.ok(selectedRemote.menu.includes(local));
  assert.ok(!selectedRemote.menu.includes(obsolete));
  const selectedLocal = await choose('0\n3\n1.5\nno\n2\n');
  assert.equal(selectedLocal.root, local);
  assert.match(selectedLocal.menu, /编号无效/);
  for (const answer of ['q\n', '\n', '']) await assert.rejects(choose(answer), /已取消/);
  await assert.rejects(choose('1\n', false), /交互终端/);
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

test('推理摘要结构缺失、歧义或重复补丁时拒绝转换', () => {
  const activity = 'function classify($,{dynamicToolCallRenderer:a,includeGeneratedImages:b=!1,mcpServerStatuses:c}={}){switch($.type){case`user-message`:return wrap($,`standalone`);case`reasoning`:return null}}function wrap(item,grouping){return{item,grouping}}';
  const renderer = 'function render(p){let t=(0,Cache.c)(3),{item:$,conversationId:a,cwd:b,hideCodeBlocks:c,hostId:d}=p,n=!$.completed,u=n?``:strip($.content),v=trim($.content).trimStart(),[x,set]=(0,React.useState)(!1);return(0,JSX.jsx)(Frame,{disclosure:{onToggle:()=>set(!x)},key:`reasoning-markdown`,text:v})}function next(){}';
  for (const [transform, source] of [[patchReasoningActivity, activity], [patchReasoningRenderer, renderer]]) {
    assert.throws(() => transform('unknown layout'), /数量异常/);
    assert.throws(() => transform(source + source), /数量异常/);
    const patched = transform(source).content;
    assert.throws(() => transform(patched), /数量异常/);
  }
  assert.throws(() => patchReasoningRenderer(renderer.replace('onToggle:', 'changedControl:')), /缺少/);
  const assistant = 'function render(p){let t=(0,Cache.c)(3),{item:n,assistantCopyText:r,turnId:i,cwd:d,conversationId:l,hostId:f}=p;return(0,JSX.jsx)(Body,{item:n})}function next(){}';
  assert.throws(() => patchReadTarget('unknown layout'), /数量异常/);
  assert.throws(() => patchReadTarget(assistant + assistant), /数量异常/);
  assert.throws(() => patchReadTarget(patchReadTarget(assistant).content), /重复转换/);
});
