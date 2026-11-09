'use strict';

const { randomUUID } = require('node:crypto');
const RETRY = 'vscodex-layer/startup-retry';

function failurePage(token) {
  const nonce = randomUUID();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}';">
<title>Codex could not start</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family,sans-serif);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:16px}
button{padding:8px;border:0;border-radius:4px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}
button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}button:disabled{opacity:.5}
.action{position:relative;display:inline-block}.tip{display:none;position:absolute;top:100%;left:0;white-space:nowrap;padding:6px;background:var(--vscode-editorHoverWidget-background);color:var(--vscode-editorHoverWidget-foreground)}
.action:hover .tip,.action:focus-within .tip{display:block}
</style></head><body><h1>Codex 界面加载超时</h1><p>可以点击刷新图标，重新加载 Codex 界面。</p>
<div class="action"><button id="retry" title="重新加载 Codex 界面" aria-label="重新加载 Codex 界面" aria-describedby="retry-tip">
<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 7v5h-5 M4 17v-5h5 M6.1 7a7 7 0 0 1 11.6-2L20 8 M4 16l2.3 3a7 7 0 0 0 11.6-2"/></svg>
</button><span class="tip" id="retry-tip" role="tooltip">重新加载 Codex 界面</span></div><p id="status" role="status"></p>
<script nonce="${nonce}">const api=acquireVsCodeApi();const button=document.getElementById("retry");
button.addEventListener("click",()=>{button.disabled=true;document.getElementById("status").textContent="正在重新加载…";
api.postMessage({type:${JSON.stringify(RETRY)},token:${JSON.stringify(token)}})});</script></body></html>`;
}

// A slow SSH asset transfer must not destroy a renderer that is still starting.
exports.createRemoteStartupGuard = ({ onSlow, webview, loadContent, beforeRetry, onError }) => class RemoteStartupGuard {
  constructor(onTimeout) { this.onTimeout = onTimeout; }
  timeout = null;
  slowTimer = null;
  slowStatus = null;
  disposed = false;
  ready = false;
  failed = false;
  retrying = false;
  generation = 0;
  retryToken = null;
  receivedWebviewMessage = false;

  start() {
    if (this.disposed || this.ready || this.failed || this.retrying || this.timeout !== null) return;
    const startedAt = Date.now();
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      this.slowStatus = onSlow?.();
    }, 30000);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.clearTimers();
      this.failed = true;
      this.onTimeout({ elapsedMs: Date.now() - startedAt,
        receivedWebviewMessage: this.receivedWebviewMessage, timeoutMs: 90000 });
      if (!this.disposed && webview) this.showFailure();
    }, 90000);
  }

  markMessageReceived() { this.receivedWebviewMessage = true; }
  handleStartupPhase(phase) {
    if (phase === 'renderer_ready' && !this.disposed && !this.failed && !this.retrying) {
      this.ready = true; this.clearTimers();
    }
  }
  showFailure() {
    this.retryToken = randomUUID();
    webview.html = failurePage(this.retryToken);
  }
  handleMessage(message) {
    if (message?.type !== RETRY) return false;
    if (!this.disposed && this.failed && !this.retrying && this.retryToken !== null && message.token === this.retryToken) {
      void this.retry();
    }
    return true;
  }
  async retry() {
    if (this.disposed || !this.failed || this.retrying) return;
    this.retrying = true; this.failed = false; this.retryToken = null;
    const generation = ++this.generation;
    this.clearTimers();
    try {
      await beforeRetry?.();
      if (this.disposed || generation !== this.generation) return;
      const html = await loadContent();
      if (this.disposed || generation !== this.generation) return;
      this.retrying = false; this.receivedWebviewMessage = false;
      webview.html = html;
      this.start();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.retrying = false; this.failed = true; this.clearTimers();
      onError?.(error);
      this.showFailure();
    }
  }
  clearTimers() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.timeout = this.slowTimer = null;
    this.slowStatus?.dispose();
    this.slowStatus = null;
  }
  dispose() { this.disposed = true; this.generation++; this.retryToken = null; this.clearTimers(); }
};
