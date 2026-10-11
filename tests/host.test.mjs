import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const { createLayerHost } = createRequire(import.meta.url)('../runtime/host.cjs');

function fixture(platform = process.platform, globalState) {
  const messages = [];
  const requests = [];
  let callbacks;
  let notify;
  const responses = new Map();
  const connection = {
    registerProvider(_name, value) { callbacks = value; return { dispose() {} }; },
    registerInternalNotificationHandler(handler) { notify = handler; return { dispose() {} }; },
    abandonRequest() {},
    sendRequest(...args) { requests.push(args); },
  };
  const target = { postMessage(message) { messages.push(message); responses.get(message.id)?.(message); responses.delete(message.id); } };
  const extensionUri = { scheme: 'file', fsPath: path.resolve('official-extension') };
  const extension = { extensionKind: 2, extensionUri };
  const states = new Map([['vscodexLayer.navigationState.v1', { mode: 'current', width: 280 }]]);
  const provider = { codexMcpConnection: connection, extensionVersion: 'test', extensionUri,
    globalState: globalState ?? { async get(key) { return states.get(key); }, async update(key, value) { states.set(key, value); } },
    postMessageToWebview(view, message) { assert.equal(view, target); messages.push(message); } };
  const vscode = { env: {}, ExtensionKind: { UI: 1, Workspace: 2 }, extensions: { getExtension: () => extension },
    workspace: { workspaceFolders: [{ name: 'Project', uri: { scheme: 'file', fsPath: 'D:\\Project' } }],
    onDidChangeWorkspaceFolders() { return { dispose() {} }; } } };
  const host = createLayerHost({ vscode, provider, webview: target, onDispose() { return { dispose() {} }; }, isWsl: () => false, platform });
  const send = (method, params = {}) => host.handle({ type: 'vscodex-layer/request', id: method, method, params });
  const request = (method, params) => new Promise((resolve) => { responses.set(method, resolve); send(method, params); });
  return { host, vscode, extension, messages, requests, send, request, callbacks: () => callbacks, notify: (message) => notify(message) };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('多面板按操作保存偏好，已读绑定轮次，重复结束不复活且写入失败可重试', async (t) => {
  const values = new Map([['vscodexLayer.navigationState.v1', { pinnedProjects: [{ path: '/legacy', name: '旧置顶' }], unread: ['legacy'] }]]);
  let fail = false;
  const store = { get: (key) => values.get(key), async update(key, value) {
    await flush(); if (fail) throw new Error('保存失败'); values.set(key, value);
  } };
  const a = fixture(process.platform, store), b = fixture(process.platform, store);
  t.after(() => { a.host.dispose(); b.host.dispose(); });
  await a.request('init'); await b.request('init');
  await Promise.all([
    a.request('save-state', { operations: [{ type: 'pin', project: { path: '/A', name: 'A' }, enabled: true }] }),
    b.request('save-state', { operations: [{ type: 'set', key: 'width', value: 310 }, { type: 'pin', project: { path: '/B' }, enabled: true }] }),
  ]);
  let state = (await a.request('init')).result.state;
  assert.deepEqual(state.pinnedProjects.map((project) => project.path), ['/legacy', '/A', '/B']);
  assert.equal(state.width, 310); assert.deepEqual(state.unread, ['legacy']);
  const completed = { method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } } };
  a.notify(completed); b.notify(completed);
  state = (await a.request('init')).result.state;
  assert.ok(state.unread.includes('thread'));
  await b.request('save-state', { operations: [{ type: 'acknowledge', threadId: 'thread', turnToken: 'turn-1' }] });
  a.notify(completed);
  assert.equal((await a.request('init')).result.state.unread.includes('thread'), false);
  a.notify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn-2' } } });
  a.notify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn-2' } } });
  await b.request('save-state', { operations: [{ type: 'acknowledge', threadId: 'thread', turnToken: 'turn-1' }] });
  assert.ok((await a.request('init')).result.state.unread.includes('thread'), '旧已读不能清除新轮次');
  a.notify(completed);
  assert.equal((await a.request('init')).result.state.unreadTurns.thread, 'turn-2', '迟到结束不能替换新轮次');
  await b.request('save-state', { operations: [{ type: 'acknowledge', threadId: 'legacy', turnToken: null }] });
  fail = true;
  assert.match((await a.request('save-state', { operations: [{ type: 'set', key: 'mode', value: 'current' }] })).error, /保存失败/);
  fail = false;
  assert.ok((await b.request('save-state', { operations: [{ type: 'set', key: 'mode', value: 'current' }] })).result.saved);
  assert.equal((await a.request('init')).result.state.mode, 'current');
  assert.ok(b.messages.some((message) => message.event?.type === 'navigation-state-changed'));
});

test('手动项目独立持久化，多个面板并发不丢记录，失败可恢复且失效目录可移除', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcl-projects-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directories = ['Project', 'project', 'project '].map((name) => path.join(root, name));
  await Promise.all(directories.map((directory) => fs.mkdir(directory)));
  const states = new Map(); let failWrite = false;
  const store = { async get(key) { return states.get(key); }, async update(key, value) {
    if (failWrite) throw new Error('保存失败');
    await flush(); states.set(key, value);
  } };
  const first = fixture(process.platform, store), second = fixture(process.platform, store);
  t.after(() => { first.host.dispose(); second.host.dispose(); });
  assert.deepEqual((await first.request('init')).result.registry, { revision: 0, projects: [] });
  const [a, b] = await Promise.all([first.request('add-project', { cwd: directories[0] }), second.request('add-project', { cwd: directories[1] })]);
  assert.ok(a.result.changed && b.result.changed);
  const registry = (await first.request('init')).result.registry;
  assert.equal(registry.revision, 2);
  assert.deepEqual(registry.projects.map((project) => project.path).sort(), directories.slice(0, 2).sort());
  assert.equal(second.messages.filter((message) => message.event?.type === 'projects-changed').length, 2);
  const duplicate = await first.request('add-project', { cwd: `${directories[0]}${path.sep}.` });
  assert.equal(duplicate.result.changed, false); assert.equal(duplicate.result.revision, 2);
  await second.request('save-state', { operations: [{ type: 'set', key: 'mode', value: 'current' }, { type: 'set', key: 'width', value: 310 }] });
  assert.deepEqual((await first.request('init')).result.registry, registry, '导航偏好保存不得覆盖项目登记');
  failWrite = true;
  assert.match((await first.request('add-project', { cwd: directories[2] })).error, /保存失败/);
  assert.deepEqual((await first.request('init')).result.registry, registry);
  failWrite = false;
  assert.equal((await second.request('add-project', { cwd: directories[2] })).result.changed, true);
  const copied = [];
  first.vscode.env.clipboard = { async writeText(value) { copied.push(value); } };
  await first.request('copy-project-path', { cwd: directories[2] });
  assert.deepEqual(copied, [directories[2]], '路径中的尾部空格不得丢失');
  await fs.rm(directories[0], { recursive: true });
  assert.match((await first.request('add-project', { cwd: directories[0] })).error, /不存在或无法访问/);
  assert.equal((await first.request('remove-project', { cwd: directories[0] })).result.changed, true);
  const reopened = fixture(process.platform, store); t.after(() => reopened.host.dispose());
  assert.deepEqual((await reopened.request('init')).result.registry.projects.map((project) => project.path).sort(), directories.slice(1).sort());
  assert.equal(first.requests.length, 0, '添加和移除不调用聊天后端');
});

test('目录选择取消不产生变更，拒绝客户端或虚拟目录并校验选中目录', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcl-picker-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let selected;
  f.vscode.window = { async showOpenDialog(options) {
    assert.equal(options.canSelectFiles, false); assert.equal(options.canSelectFolders, true); assert.equal(options.canSelectMany, false);
    return selected;
  } };
  assert.equal((await f.request('pick-project-folder')).result.cancelled, true);
  selected = [{ scheme: 'vscode-local', fsPath: root }];
  assert.match((await f.request('pick-project-folder')).error, /当前运行主机/);
  selected = [{ scheme: 'file', fsPath: root }];
  assert.equal((await f.request('pick-project-folder')).result.cwd, root);
  assert.deepEqual((await f.request('init')).result.registry.projects, [], '选择目录本身不登记项目');
  await fs.rm(root, { recursive: true });
  assert.match((await f.request('pick-project-folder')).error, /不存在或无法访问/);
});

test('POSIX 项目目录必须同时可读取和进入，拒绝后仍可重试', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcl-project-access-'));
  const directory = path.join(root, 'project'); await fs.mkdir(directory);
  t.after(async () => { await fs.chmod(directory, 0o700); await fs.rm(root, { recursive: true, force: true }); });
  for (const mode of [0o400, 0o100]) {
    await fs.chmod(directory, mode);
    assert.match((await f.request('validate-project', { cwd: directory })).error, /无法访问/);
    assert.match((await f.request('new-project-chat', { cwd: directory, path: '/' })).error, /无法访问/);
    assert.equal(f.messages.some((message) => message.type === 'navigate-to-route'), false);
  }
  await fs.chmod(directory, 0o500);
  assert.equal((await f.request('validate-project', { cwd: directory })).result.cwd, directory);
  assert.equal((await f.request('new-project-chat', { cwd: directory, path: '/' })).result.cwd, directory);
});

test('项目置顶偏好保存并过滤无效目录，旧偏好正常读取', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  assert.deepEqual((await f.request('init')).result.state.pinnedProjects, []);
  const pinnedProjects = [{ path: '/home/Project', name: 'Project' }, { path: 'D:\\Other\\Project', name: '同名目录' }];
  await f.request('save-state', { operations: [...pinnedProjects, { path: '/home/Project', name: '重复' },
    { path: 'relative', name: '无效' }, { path: '/a\0b' }, null].map((project) => ({ type: 'pin', project, enabled: true })) });
  assert.deepEqual((await f.request('init')).result.state.pinnedProjects, pinnedProjects);
});

test('独立摘要使用内存 Markdown 阅读视图，实时更新隔离且不请求模型', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  let documentProvider;
  let registrations = 0;
  let disposed = 0;
  const changes = [];
  const commands = [];
  f.vscode.EventEmitter = class {
    event = () => ({ dispose() {} });
    fire(uri) { changes.push(uri); }
    dispose() { disposed += 1; }
  };
  f.vscode.Uri = { from: (parts) => parts };
  f.vscode.workspace.registerTextDocumentContentProvider = (scheme, value) => {
    assert.match(scheme, /^vscodex-reasoning-/);
    documentProvider = value; registrations += 1;
    return { dispose() { disposed += 1; } };
  };
  f.vscode.workspace.openTextDocument = async (uri) => ({ uri });
  f.vscode.commands = { async executeCommand(...args) { commands.push(args); } };
  const detail = { hostId: 'local', conversationId: 'thread', itemId: 'thought', content: '**标题**\n\n第一段', completed: false };
  assert.equal((await f.request('update-reasoning-view', detail)).result.updated, false);
  assert.equal(registrations, 0, '不打开阅读视图时不注册文档或保存正文');
  assert.equal((await f.request('open-reasoning-view', detail)).result.opened, true);
  assert.equal(commands[0][0], 'markdown.showPreview');
  const uri = commands[0][1];
  assert.equal(uri.path, '/思考摘要.md');
  assert.equal(registrations, 1);
  assert.ok(documentProvider.provideTextDocumentContent(uri).includes('生成中'));
  assert.ok(documentProvider.provideTextDocumentContent(uri).endsWith(detail.content));
  const count = changes.length;
  for (const changed of [{ hostId: 'remote' }, { conversationId: 'other' }, { itemId: 'other' }]) {
    assert.equal((await f.request('update-reasoning-view', { ...detail, ...changed, content: '其他正文' })).result.updated, false);
  }
  await f.request('update-reasoning-view', detail);
  assert.equal(changes.length, count, '重复内容和其他摘要不刷新当前阅读视图');
  const finished = { ...detail, content: detail.content + '\n第二段', completed: true };
  await f.request('update-reasoning-view', finished);
  assert.equal(changes.length, count + 1);
  assert.ok(documentProvider.provideTextDocumentContent(uri).includes('已完成'));
  assert.ok(documentProvider.provideTextDocumentContent(uri).endsWith(finished.content));
  await f.request('open-reasoning-view', { ...detail, itemId: 'next' });
  assert.equal(registrations, 1, '同一聊天面板复用内存阅读文档');
  assert.match((await f.request('open-reasoning-view', { ...detail, content: null })).error, /正文无效/);
  assert.equal(f.requests.length, 0, '摘要阅读不调用后端或产生新聊天');
  f.host.dispose();
  assert.equal(disposed, 2);
  assert.ok(!documentProvider.provideTextDocumentContent(uri).includes('第一段'), '面板销毁后释放正文');
});

test('审批和输入状态保留，结束事件只转发导航所需字段', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  const pending = f.request('list'); await flush();
  f.callbacks().onResult({ id: f.requests.at(-1)[1], result: { data: [{ id: 'one',
    status: { type: 'active', activeFlags: ['waitingOnApproval', 'waitingOnUserInput', 'unknown'] } }], nextCursor: null } });
  assert.deepEqual((await pending).result.data[0].activeFlags, ['waitingOnApproval', 'waitingOnUserInput']);
  for (const [method, params, expected] of [
    ['thread/status/changed', { threadId: 'one', status: { type: 'active', activeFlags: ['waitingOnUserInput'] } },
      { phase: 'status', status: 'active', activeFlags: ['waitingOnUserInput'] }],
    ['turn/started', { threadId: 'one', turn: { id: 'turn', items: ['secret'] } },
      { phase: 'started', status: 'active', activeFlags: [] }],
    ['turn/completed', { threadId: 'one', turn: { status: 'completed', items: ['secret'] } },
      { phase: 'completed', status: 'idle', activeFlags: [] }],
    ['turn/completed', { threadId: 'one', turn: { status: 'failed', error: 'secret' } },
      { phase: 'completed', status: 'systemError', activeFlags: [] }],
    ['turn/completed', { threadId: 'one', turn: { id: 'turn', status: 'completed',
      items: [{ type: 'agentMessage', id: 'reply', phase: 'final_answer', text: 'secret' }] } },
      { phase: 'completed', status: 'idle', activeFlags: [], replyItemId: 'reply' }],
  ]) {
    f.messages.length = 0; f.notify({ method, params }); await flush();
    const activity = f.messages.find((message) => message.event?.type === 'thread-activity').event;
    const { turnToken, unread, ...publicEvent } = activity;
    assert.deepEqual(publicEvent, { type: 'thread-activity', threadId: 'one', ...expected });
    if (expected.phase !== 'status') assert.equal(typeof turnToken, 'string');
    assert.equal(JSON.stringify(f.messages).includes('secret'), false, '通知与状态广播不得泄漏正文');
  }
  f.messages.length = 0;
  f.notify({ method: 'item/completed', params: { threadId: 'one', turnId: 'next',
    item: { type: 'agentMessage', id: 'last-reply', phase: 'final_answer', text: 'secret' } } });
  f.notify({ method: 'item/completed', params: { threadId: 'one', turnId: 'next',
    item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: 'secret' } } });
  assert.deepEqual(f.messages, [], '回复正文和中间进度不得转发给导航');
  f.notify({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'next', status: 'completed', items: [] } } });
  await flush();
  assert.equal(f.messages.find((message) => message.event?.type === 'thread-activity').event.replyItemId, 'last-reply', '结束通知没有 items 时沿用同轮次的已完成回复编号');
  f.messages.length = 0;
  f.notify({ method: 'item/completed', params: { threadId: 'one', turnId: 'old',
    item: { type: 'agentMessage', id: 'old-reply', phase: 'final_answer' } } });
  f.notify({ method: 'turn/completed', params: { threadId: 'one', turn: { id: 'new', status: 'completed' } } });
  await flush();
  assert.equal(f.messages.find((message) => message.event?.type === 'thread-activity').event.replyItemId, undefined, '不能关联其他轮次的回复');
  const state = (await f.request('init')).result.state;
  assert.deepEqual(state.unread, ['one']);
  await f.request('save-state', { operations: [{ type: 'acknowledge', threadId: 'one', turnToken: state.unreadTurns.one }] });
  assert.deepEqual((await f.request('init')).result.state.unread, []);
  assert.match((await f.request('save-state', { operations: [{ type: 'acknowledge', threadId: '../invalid' }] })).error, /无效/);
  f.messages.length = 0;
  f.notify({ method: 'thread/status/changed', params: { threadId: '../invalid' } });
  assert.equal(f.messages.some((message) => typeof message.event === 'object'), false);
});

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

test('归档列表独立分页并限制筛选类型，沿用宿主连接且不恢复聊天', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  for (const archived of [false, true]) {
    const pending = f.request('list', { cursor: 'next-page', archived }); await flush();
    const request = f.requests.at(-1);
    assert.equal(request[2], 'thread/list');
    assert.equal(request[3].archived, archived);
    assert.equal(request[3].cursor, 'next-page');
    f.callbacks().onResult({ id: request[1], result: { data: [{ id: 'saved', name: '归档记录', cwd: '/project',
      updatedAt: 123, turns: ['secret'] }], nextCursor: 'following' } });
    const response = (await pending).result;
    assert.equal(response.nextCursor, 'following');
    assert.equal(response.data[0].updatedAt, 123);
    assert.equal('turns' in response.data[0], false);
  }
  for (const archived of ['true', null, 1]) assert.match((await f.request('list', { archived })).error, /筛选参数无效/);
  assert.equal(f.requests.length, 2);
  f.messages.length = 0; f.notify({ method: 'thread/unarchived', params: { threadId: 'saved' } });
  assert.deepEqual(f.messages, [{ type: 'vscodex-layer/event', event: { type: 'threads-changed', method: 'thread/unarchived', threadId: 'saved' } }]);
});

test('不支持的远程工作区和无效路由被拒绝', async (t) => {
  const f = fixture('linux'); t.after(() => f.host.dispose());
  f.vscode.env.remoteName = 'ssh-remote';
  f.send('init'); await flush();
  assert.equal(f.messages.at(-1).result.supported, false);
  f.send('list'); await flush();
  assert.match(f.messages.at(-1).error, /当前远程宿主/);
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
  f.vscode.workspace.workspaceFolders = [{ name: 'Client', uri: { scheme: 'vscode-local', fsPath: current } }];
  assert.match((await f.request('new-project-chat', { cwd: current, path: '/' })).error, /当前远程宿主|远程 Linux/);
});

test('Linux SSH 宿主读取同主机聊天并校验远程目录，错误宿主拒绝请求', async (t) => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'vscodex-ssh-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const f = fixture('linux'); t.after(() => f.host.dispose());
  f.vscode.env.remoteName = 'ssh-remote';
  const remoteFolder = { name: 'Remote', uri: { scheme: 'file', authority: '', fsPath: directory } };
  f.vscode.workspace.workspaceFolders = [remoteFolder];
  const init = (await f.request('init')).result;
  assert.equal(init.supported, true);
  assert.equal(init.mode, 'ssh-remote');
  assert.equal(init.folders[0].path, directory);
  f.vscode.workspace.workspaceFolders = [remoteFolder,
    { name: 'Other', uri: { scheme: 'file', authority: '', fsPath: path.join(directory, 'other') } }];
  assert.equal((await f.request('init')).result.supported, true, '同一远程宿主的多根 file 工作区必须受支持');
  const reply = await f.request('new-project-chat', { cwd: directory, path: '/' });
  assert.equal(reply.result.cwd, directory);
  assert.equal(f.requests.length, 0, '打开 SSH 项目草稿不创建线程');
  const pending = f.request('list'); await flush();
  f.callbacks().onResult({ id: f.requests.at(-1)[1], result: { data: [{ id: 'ssh-thread', cwd: directory }], nextCursor: null } });
  assert.equal((await pending).result.data[0].cwd, directory);
  await f.request('navigate', { threadId: 'ssh-thread' });
  assert.deepEqual(f.messages.at(-2), { type: 'navigate-to-route', path: '/local/ssh-thread' });
  assert.ok((await f.request('validate-project', { cwd: 'D:\\Project' })).error);
  await fs.rmdir(directory);
  assert.match((await f.request('validate-project', { cwd: directory })).error, /不存在或无法访问/);
  const extensionUri = f.extension.extensionUri;
  for (const mutate of [
    () => { f.extension.extensionKind = 1; },
    () => { f.extension.extensionKind = 2; f.vscode.workspace.workspaceFolders = [remoteFolder,
      { ...remoteFolder, uri: { ...remoteFolder.uri, scheme: 'vscode-local' } }]; },
    () => { f.vscode.workspace.workspaceFolders = [{ ...remoteFolder, uri: { ...remoteFolder.uri, scheme: 'memfs' } }]; },
    () => { f.vscode.workspace.workspaceFolders = [{ ...remoteFolder, uri: { ...remoteFolder.uri, authority: 'other' } }]; },
    () => { f.vscode.workspace.workspaceFolders = [{ ...remoteFolder, uri: { ...remoteFolder.uri, fsPath: 'relative' } }]; },
    () => { f.vscode.workspace.workspaceFolders = [remoteFolder]; f.extension.extensionUri = { scheme: 'file', fsPath: path.join(directory, 'wrong-extension') }; },
    () => { f.vscode.env.remoteName = 'dev-container'; },
    () => { f.vscode.env.remoteName = 'wsl'; },
  ]) {
    f.vscode.env.remoteName = 'ssh-remote';
    f.vscode.workspace.workspaceFolders = [remoteFolder];
    f.extension.extensionKind = 2;
    f.extension.extensionUri = extensionUri;
    mutate();
    assert.equal((await f.request('init')).result.supported, false);
    const before = f.requests.length;
    assert.ok((await f.request('list')).error);
    assert.ok((await f.request('new-project-chat', { cwd: directory, path: '/' })).error);
    assert.equal(f.requests.length, before);
  }
  const windows = fixture('win32'); t.after(() => windows.host.dispose());
  windows.vscode.env.remoteName = 'ssh-remote';
  windows.vscode.workspace.workspaceFolders = [remoteFolder];
  assert.equal((await windows.request('init')).result.supported, false);
});

test('活动通知不触发完整列表刷新，归档通知携带目标编号', async (t) => {
  const f = fixture(); t.after(() => f.host.dispose());
  for (const method of ['thread/status/changed', 'turn/started', 'turn/completed']) {
    f.messages.length = 0;
    f.notify({ method, params: { threadId: 'thread', status: { type: 'active' }, turn: { id: 'turn' } } });
    await flush();
    assert.equal(f.messages.some((message) => message.event === 'threads-changed' || message.event?.type === 'threads-changed'), false);
  }
  f.messages.length = 0;
  f.notify({ method: 'thread/archived', params: { threadId: 'thread' } });
  assert.deepEqual(f.messages[0].event, { type: 'threads-changed', method: 'thread/archived', threadId: 'thread' });
});
