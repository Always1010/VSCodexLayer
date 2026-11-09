'use strict';

// A slow SSH asset transfer must not destroy a renderer that is still starting.
exports.createRemoteStartupGuard = ({ onSlow }) => class RemoteStartupGuard {
  constructor(onTimeout) { this.onTimeout = onTimeout; }
  timeout = null;
  slowTimer = null;
  slowStatus = null;
  disposed = false;
  receivedWebviewMessage = false;

  start() {
    if (this.disposed || this.timeout !== null) return;
    const startedAt = Date.now();
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      this.slowStatus = onSlow?.();
    }, 30000);
    this.timeout = setTimeout(() => {
      this.timeout = null;
      this.clearTimers();
      this.onTimeout({ elapsedMs: Date.now() - startedAt,
        receivedWebviewMessage: this.receivedWebviewMessage, timeoutMs: 90000 });
    }, 90000);
  }

  markMessageReceived() { this.receivedWebviewMessage = true; }
  handleStartupPhase(phase) { if (phase === 'renderer_ready') this.dispose(); }
  clearTimers() {
    if (this.timeout !== null) clearTimeout(this.timeout);
    if (this.slowTimer !== null) clearTimeout(this.slowTimer);
    this.timeout = this.slowTimer = null;
    this.slowStatus?.dispose();
    this.slowStatus = null;
  }
  dispose() { this.disposed = true; this.clearTimers(); }
};
