import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { patchWebviewStartup } from '../adapters/webview-startup.mjs';

const runtime = fs.readFileSync(new URL('../runtime/startup.cjs', import.meta.url), 'utf8');
function fixture(options = {}) {
  let now = 0, sequence = 0, slow = 0, statusDisposed = 0;
  const timers = new Map(), timeouts = [];
  const context = vm.createContext({ exports: {}, require: createRequire(import.meta.url), Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(runtime, context);
  const Guard = context.exports.createRemoteStartupGuard({
    onSlow: () => { slow++; return { dispose: () => { statusDisposed++; } }; },
    ...options,
  });
  const guard = new Guard((event) => timeouts.push(event));
  return { guard, context, timeouts, timers, get slow() { return slow; }, get statusDisposed() { return statusDisposed; },
    advance(to) {
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      now = to;
    } };
}

test('远程渲染超过 30 秒仍可就绪，完成后清理提示和计时器', () => {
  const f = fixture();
  f.guard.start(); f.guard.start();
  f.advance(30000);
  assert.equal(f.slow, 1); assert.equal(f.timeouts.length, 0);
  f.guard.markMessageReceived(); f.guard.handleStartupPhase('settings_ready');
  f.advance(45000); f.guard.handleStartupPhase('renderer_ready');
  f.advance(120000);
  assert.equal(f.timeouts.length, 0); assert.equal(f.statusDisposed, 1); assert.equal(f.timers.size, 0);
});

test('远程界面在 90 秒仍未就绪时报告实际超时，关闭后不再回调', () => {
  const f = fixture(); f.guard.start(); f.guard.markMessageReceived(); f.advance(90000);
  assert.equal(f.timeouts.length, 1);
  assert.equal(f.timeouts[0].timeoutMs, 90000);
  assert.equal(f.timeouts[0].elapsedMs, 90000);
  assert.equal(f.timeouts[0].receivedWebviewMessage, true);
  const closed = fixture(); closed.guard.start(); closed.guard.dispose(); closed.advance(120000);
  assert.equal(closed.slow, 0); assert.equal(closed.timeouts.length, 0); assert.equal(closed.timers.size, 0);
});

test('启动补丁只在 Linux SSH 宿主使用远程监控，结构缺失或歧义时拒绝', () => {
  const source = 'let s=new NativeGuard(u=>{this.logger.error("Webview renderer did not become ready",u)});'
    + 'let a=e.onDidReceiveMessage(u=>{});return s;';
  const patched = patchWebviewStartup(source, 'api');
  for (const [platform, remoteName, expected] of [['linux', 'ssh-remote', 'remote'], ['linux', undefined, 'native'],
    ['win32', 'ssh-remote', 'native'], ['linux', 'wsl', 'native'], ['linux', 'dev-container', 'native']]) {
    const calls = [];
    const context = vm.createContext({ process: { platform }, NativeGuard: class { kind = 'native'; },
      api: { env: { remoteName }, Uri: { joinPath: () => ({ fsPath: '/extension/out/vscodex-layer-startup.cjs' }) } },
      e: { onDidReceiveMessage: () => ({ dispose() {} }) },
      require: (file) => { calls.push(file); return { createRemoteStartupGuard: () => class { kind = 'remote'; } }; } });
    const guard = vm.runInContext(`(function(){${patched}}).call({extensionUri:{}})`, context);
    assert.equal(guard.kind, expected); assert.equal(calls.length, expected === 'remote' ? 1 : 0);
  }
  assert.throws(() => patchWebviewStartup('', 'api'), /数量异常/);
  assert.throws(() => patchWebviewStartup(source + source, 'api'), /数量异常/);
  assert.throws(() => patchWebviewStartup(source.replace('let a=e.', 'let b=e.'), 'api'), /消息接入点/);
});

function retryMessage(html) {
  const script = /<script nonce="[^"]+">([\s\S]+?)<\/script>/.exec(html)?.[1];
  assert.ok(script, '失败页必须能在独立的受限脚本中发送重试');
  const button = { addEventListener: (_event, listener) => { button.click = listener; } };
  let message;
  vm.runInNewContext(script, { acquireVsCodeApi: () => ({ postMessage: (value) => { message = value; } }),
    document: { getElementById: (id) => id === 'retry' ? button : {} } });
  button.click(); assert.equal(button.disabled, true);
  return message;
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('失败页局部重试复用面板，拒绝伪造和重复请求，就绪后不再接受重试', async () => {
  const webview = { html: '' }; let loads = 0, cleanups = 0;
  const f = fixture({ webview, beforeRetry: () => { cleanups++; }, loadContent: async () => { loads++; return '<official />'; } });
  f.guard.start(); f.advance(90000);
  assert.match(webview.html, /default-src 'none'/);
  assert.match(webview.html, /aria-label="重新加载 Codex 界面"/);
  assert.equal(f.guard.handleMessage({ type: 'ready' }), false);
  f.guard.handleMessage({ type: 'vscodex-layer/startup-retry', token: 'forged' });
  assert.equal(loads, 0);
  const message = retryMessage(webview.html);
  f.guard.handleMessage(message); f.guard.handleMessage(message);
  await flush();
  assert.equal(loads, 1); assert.equal(cleanups, 1); assert.equal(webview.html, '<official />');
  assert.equal(f.guard.receivedWebviewMessage, false);
  f.advance(135000); f.guard.handleStartupPhase('renderer_ready'); f.advance(200000);
  assert.equal(f.timeouts.length, 1); assert.equal(f.timers.size, 0);
  f.guard.handleMessage(message); await flush(); assert.equal(loads, 1);
});

test('重试读取失败仍可再试，超时后旧就绪信号不取消重试，关闭后迟到读取不改写页面', async () => {
  const webview = { html: '' }; const errors = []; let rejectLoad = true;
  const f = fixture({ webview, loadContent: async () => { if (rejectLoad) throw new Error('read-failed'); return '<official />'; },
    onError: (error) => errors.push(error) });
  f.guard.start(); f.advance(90000); f.guard.handleStartupPhase('renderer_ready');
  const first = retryMessage(webview.html);
  f.guard.handleMessage(first); await flush();
  assert.equal(errors.length, 1); assert.match(webview.html, /界面加载超时/);
  const second = retryMessage(webview.html); assert.notEqual(first.token, second.token);
  rejectLoad = false; f.guard.handleMessage(first); await flush(); assert.equal(f.guard.failed, true);
  f.guard.handleMessage(second); await flush(); assert.equal(webview.html, '<official />');
  f.advance(180000); assert.equal(f.timeouts.length, 2);
  let finishLoad;
  const closedView = { html: '' };
  const closed = fixture({ webview: closedView, loadContent: () => new Promise((resolve) => { finishLoad = resolve; }) });
  closed.guard.start(); closed.advance(90000);
  closed.guard.handleMessage(retryMessage(closedView.html)); await flush();
  closed.guard.dispose(); closedView.html = '<closed />'; finishLoad('<late />'); await flush();
  assert.equal(closedView.html, '<closed />'); assert.equal(closed.timers.size, 0);
});
