import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';

// Execute the real generated initializer: a standalone guard test cannot prove
// that its callback captures the right provider, webview, or minified bindings.
export async function checkNativeStartup(source, runtime, namespace) {
  const begin = source.indexOf('async initializeWebview(e,r,n,o){');
  const end = source.indexOf('onPanelReady(e){', begin);
  assert.ok(begin >= 0 && end > begin, '需要唯一的官方界面初始化函数');
  let now = 0, id = 0, guard, loads = 0, hostLoads = 0, abandoned = 0, cleared = 0, slow = 0;
  const timers = new Map(), listeners = new Set(), closing = new Set(), sessions = new Map();
  const context = vm.createContext({ exports: {}, Date: { now: () => now },
    require: createRequire(import.meta.url),
    setTimeout: (fn, delay) => { timers.set(++id, { fn, at: now + delay }); return id; },
    clearTimeout: (key) => timers.delete(key) });
  vm.runInContext(runtime, context);
  const factory = context.exports.createRemoteStartupGuard;
  const webview = { html: '', onDidReceiveMessage(fn) { listeners.add(fn); return { dispose: () => listeners.delete(fn) }; } };
  const view = { webview }, panel = {};
  const onDispose = (fn) => { closing.add(fn); return { dispose: () => closing.delete(fn) }; };
  const provider = { extensionUri: { fsPath: '/fixture' }, extensionVersion: 'fixture', subscriptions: [],
    sidebarViews: new Set([view]), readySidebarViews: new Set([view]), sidebarView: view, sidebarWebviewReady: true,
    editorPanels: new Map([[panel, { ready: true }]]), findPanelByWebview: () => panel,
    // A UI retry must never touch, restart, or replace the app-server connection.
    codexMcpConnection: new Proxy({}, { get() { throw new Error('界面重试不得操作后端连接'); } }),
    logger: { warning: () => {}, error: () => {} },
    async getWebviewContent(target) { assert.equal(target, webview); loads++; return `<official-${loads}/>`; },
    registerClientCoordinationForWebview(target, close, startup) {
      assert.equal(target, webview); assert.equal(close, onDispose); assert.equal(startup, guard);
      assert.equal(sessions.size, 0); sessions.set(target, startup);
    },
    disposeClientCoordinationForWebview: (target) => sessions.delete(target),
    clearPendingRequestsForWebview: (target) => { assert.equal(target, webview); abandoned++; },
    chunkedMessageSender: { dispose: (target) => { assert.equal(target, webview); cleared++; } },
    workerBusMessageHandler: { registerWebview: () => {} }, handleMessage: () => {},
  };
  const vscode = { env: { remoteName: 'ssh-remote' }, Uri: { joinPath: (root, ...parts) => ({ fsPath: path.join(root.fsPath, ...parts) }) },
    window: { showErrorMessage() {}, setStatusBarMessage() { slow++; return { dispose() {} }; } } };
  Object.assign(context, { provider, webview, onDispose, process: { platform: 'linux' }, [namespace]: vscode,
    require: (file) => {
      if (file === '/fixture/out/vscodex-layer-startup.cjs') return { createRemoteStartupGuard: (options) => {
        const Guard = factory(options);
        return class extends Guard { constructor(onTimeout) { super(onTimeout); guard = this; } };
      } };
      assert.equal(file, '/fixture/out/vscodex-layer-host.cjs'); hostLoads++;
      return { createLayerHost: () => ({ handle: () => false, dispose() {} }) };
    } });
  const initialize = vm.runInContext(`({${source.slice(begin, end)}}).initializeWebview`, context);
  for (const role of ['sidebar', 'panel']) {
    await initialize.call(provider, webview, role, onDispose);
    assert.equal(timers.size, 2);
    now += 90000;
    for (const [key, timer] of [...timers]) { timers.delete(key); timer.fn(); }
    assert.match(webview.html, /重新加载 Codex 界面/);
    assert.equal(slow > 0, true);
    // An obsolete renderer reaching ready after timeout cannot disable recovery.
    guard.handleStartupPhase('renderer_ready');
    const message = { type: 'vscodex-layer/startup-retry', token: guard.retryToken };
    for (const listener of listeners) listener(message);
    for (const listener of listeners) listener(message);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loads, role === 'sidebar' ? 2 : 4);
    assert.equal(listeners.size, 1, '重试不得重复注册宿主消息监听器');
    assert.equal(sessions.size, 1, '旧界面会话必须清理后再注册');
    assert.equal(hostLoads, role === 'sidebar' ? 1 : 2, '重试复用增强宿主');
    assert.equal(provider.sidebarWebviewReady, false);
    assert.equal(provider.readySidebarViews.size, 0);
    if (role === 'panel') assert.equal(provider.editorPanels.get(panel).ready, false);
    guard.handleStartupPhase('renderer_ready');
    assert.equal(timers.size, 0);
    for (const close of [...closing]) close();
    for (const subscription of provider.subscriptions) subscription.dispose();
    provider.subscriptions = []; sessions.clear(); closing.clear();
  }
  assert.equal(abandoned, 2); assert.equal(cleared, 4); assert.equal(listeners.size, 0);
}
