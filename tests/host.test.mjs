import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { createLayerHost } = createRequire(import.meta.url)('../runtime/host.cjs');

function fixture() {
  const messages = [];
  const requests = [];
  let callbacks;
  const connection = {
    registerProvider(_name, value) { callbacks = value; return { dispose() {} }; },
    registerInternalNotificationHandler() { return { dispose() {} }; },
    abandonRequest() {},
    sendRequest(...args) { requests.push(args); },
  };
  const target = { postMessage(message) { messages.push(message); } };
  const provider = { codexMcpConnection: connection, extensionVersion: 'test',
    globalState: { async get() { return { mode: 'current', width: 280 }; }, async update() {} },
    postMessageToWebview(view, message) { assert.equal(view, target); messages.push(message); } };
  const vscode = { env: {}, workspace: { workspaceFolders: [{ name: 'Project', uri: { scheme: 'file', fsPath: 'D:\\Project' } }],
    onDidChangeWorkspaceFolders() { return { dispose() {} }; } } };
  const host = createLayerHost({ vscode, provider, webview: target, onDispose() { return { dispose() {} }; }, isWsl: () => false });
  const send = (method, params = {}) => host.handle({ type: 'vscodex-layer/request', id: method, method, params });
  return { host, vscode, messages, requests, send, callbacks: () => callbacks };
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
});
