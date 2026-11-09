import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { patchWebviewStartup } from '../adapters/webview-startup.mjs';

const runtime = fs.readFileSync(new URL('../runtime/startup.cjs', import.meta.url), 'utf8');
function fixture() {
  let now = 0, sequence = 0, slow = 0, statusDisposed = 0;
  const timers = new Map(), timeouts = [];
  const context = vm.createContext({ exports: {}, Date: { now: () => now },
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(runtime, context);
  const Guard = context.exports.createRemoteStartupGuard({
    onSlow: () => { slow++; return { dispose: () => { statusDisposed++; } }; },
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
  const source = 'let s=new NativeGuard(u=>{this.logger.error("Webview renderer did not become ready",u)});return s;';
  const patched = patchWebviewStartup(source, 'api');
  for (const [platform, remoteName, expected] of [['linux', 'ssh-remote', 'remote'], ['linux', undefined, 'native'],
    ['win32', 'ssh-remote', 'native'], ['linux', 'wsl', 'native'], ['linux', 'dev-container', 'native']]) {
    const calls = [];
    const context = vm.createContext({ process: { platform }, NativeGuard: class { kind = 'native'; },
      api: { env: { remoteName }, Uri: { joinPath: () => ({ fsPath: '/extension/out/vscodex-layer-startup.cjs' }) } },
      require: (file) => { calls.push(file); return { createRemoteStartupGuard: () => class { kind = 'remote'; } }; } });
    const guard = vm.runInContext(`(function(){${patched}}).call({extensionUri:{}})`, context);
    assert.equal(guard.kind, expected); assert.equal(calls.length, expected === 'remote' ? 1 : 0);
  }
  assert.throws(() => patchWebviewStartup('', 'api'), /数量异常/);
  assert.throws(() => patchWebviewStartup(source + source, 'api'), /数量异常/);
});
