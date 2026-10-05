export class LayerClient {
  constructor(bridge, surface = window) {
    this.bridge = bridge;
    this.surface = surface;
    this.pending = new Map();
    this.listeners = new Set();
    this.receive = (event) => {
      if (event.origin !== surface.location.origin) return;
      const message = event.data;
      if (message?.type === 'vscodex-layer/response') {
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      } else if (message?.type === 'vscodex-layer/event') {
        for (const listener of this.listeners) listener(message.event);
      }
    };
    surface.addEventListener('message', this.receive);
  }
  request(method, params = {}) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('增强消息超时，请刷新或返回原版界面。'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.bridge.postMessage({ type: 'vscodex-layer/request', id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispose() {
    this.surface.removeEventListener('message', this.receive);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer); request.reject(new Error('增强导航已关闭。'));
    }
    this.pending.clear();
    this.listeners.clear();
  }
}
