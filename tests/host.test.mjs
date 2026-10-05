import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { createLayerHost } = createRequire(import.meta.url)('../runtime/host.cjs');

function fixture() {
  const messages = [];
  const requests = [];
  let callbacks;
  const responses = new Map();
  const connection = {
    registerProvider(_name, value) { callbacks = value; return { dispose() {} }; },
    registerInternalNotificationHandler() { return { dispose() {} }; },
    abandonRequest() {},
    sendRequest(...args) { requests.push(args); },
  };
  const target = { postMessage(message) { messages.push(message); responses.get(message.id)?.(message); responses.delete(message.id); } };
  const provider = { codexMcpConnection: connection, extensionVersion: 'test',
    globalState: { async get() { return { mode: 'current', width: 280 }; }, async update() {} },
    postMessageToWebview(view, message) { assert.equal(view, target); messages.push(message); } };
  const vscode = { env: {}, workspace: { workspaceFolders: [{ name: 'Project', uri: { scheme: 'file', fsPath: 'D:\\Project' } }],
    onDidChangeWorkspaceFolders() { return { dispose() {} }; } } };
  const host = createLayerHost({ vscode, provider, webview: target, onDispose() { return { dispose() {} }; }, isWsl: () => false });
  const send = (method, params = {}) => host.handle({ type: 'vscodex-layer/request', id: method, method, params });
  const request = (method, params) => new Promise((resolve) => { responses.set(method, resolve); send(method, params); });
  return { host, vscode, messages, requests, send, request, callbacks: () => callbacks };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('同面板导航，只读取聊天摘要，不接管官方消息', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  assert.equal(f.host.handle({ type: 'ready' }), false);
  f.send('init'); await flush();
  assert.equal(f.messages.at(-1).result.state.mode, 'current');
  f.messages.length = 0;
  f.send('navigate', { threadId: 'thread-123' }); await flush();
  assert.deepEqual(f.messages[0], { type: 'navigate-to-route', path: '/local/thread-123' });
  f.send('list', { cursor: 'next-page' }); await flush();
  assert.equal(f.requests[0][2], 'thread/list');
  assert.equal(f.requests[0][3].cursor, 'next-page');
  f.callbacks().onResult({ id: f.requests[0][1], result: { data: [{ id: 'one', name: 'Title', cwd: 'D:\\Project', turns: ['secret'] }], nextCursor: null } });
  await flush();
  const result = f.messages.at(-1).result;
  assert.equal(result.data[0].title, 'Title');
  assert.equal('turns' in result.data[0], false);
  assert.equal(f.requests.length, 1);
  for (const path of ['/', '/extension/panel/new']) {
    f.send('new-chat', { path }); await flush();
    assert.deepEqual(f.messages.at(-2), { type: 'navigate-to-route', path });
  }
  assert.equal(f.requests.length, 1, '返回空白页不能创建聊天');
});

test('远程模式和无效路由被拒绝', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  f.vscode.env.remoteName = 'ssh-remote';
  f.send('init'); await flush();
  assert.equal(f.messages.at(-1).result.supported, false);
  f.send('list'); await flush();
  assert.match(f.messages.at(-1).error, /本地工作区/);
  f.vscode.env.remoteName = undefined;
  f.send('navigate', { threadId: '../settings' }); await flush();
  assert.match(f.messages.at(-1).error, /编号无效/);
  assert.equal(f.requests.length, 0);
  f.send('new-chat', { path: '/settings' }); await flush();
  assert.match(f.messages.at(-1).error, /空白聊天入口/);
});

test('项目新聊天绑定完整目录，不创建线程，失效目录拒绝回退', async (t) => {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'vscodex-layer-project-'));
  assert.ok(root.startsWith(`${parent}${path.sep}vscodex-layer-project-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const current = path.join(root, 'current', 'Project');
  const other = path.join(root, 'other', 'Project');
  const worktree = path.join(root, 'worktrees', 'branch');
  for (const directory of [current, other, worktree]) await fs.mkdir(directory, { recursive: true });
  const f = fixture(); t.after(() => f.host.dispose());
  f.vscode.workspace.workspaceFolders = [current, worktree].map((directory) => ({ name: 'Project', uri: { scheme: 'file', fsPath: directory } }));
  for (const directory of [current, other, worktree]) {
    for (const route of ['/', '/extension/panel/new']) {
      const reply = await f.request('new-project-chat', { cwd: directory, path: route });
      assert.equal(reply.result.cwd, directory);
      assert.equal(new URL(reply.result.path, 'https://layer.local').searchParams.get('vclProjectCwd'), directory);
      assert.deepEqual(f.messages.at(-2), { type: 'navigate-to-route', path: reply.result.path });
    }
  }
  assert.equal(f.requests.length, 0, '点击项目按钮不能发送 thread/start 或 turn/start');
  assert.equal((await f.request('validate-project', { cwd: other })).result.cwd, other);
  const file = path.join(root, 'file.txt'); await fs.writeFile(file, 'test');
  for (const cwd of [null, '', 'relative/Project', file, path.join(root, 'missing')]) {
    const before = f.messages.filter((message) => message.type === 'navigate-to-route').length;
    assert.ok((await f.request('new-project-chat', { cwd, path: '/' })).error);
    assert.equal(f.messages.filter((message) => message.type === 'navigate-to-route').length, before);
  }
  await fs.rmdir(other);
  assert.match((await f.request('validate-project', { cwd: other })).error, /不存在或无法访问/);
  f.vscode.env.remoteName = 'ssh-remote';
  assert.match((await f.request('new-project-chat', { cwd: current, path: '/' })).error, /本地工作区/);
});
