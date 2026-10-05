/* Runs before the official module. The official app remains the sole acquirer of its VS Code API. */
(() => {
  if (globalThis.__vscodexLayerBridge || typeof globalThis.acquireVsCodeApi !== 'function') return;
  const acquire = globalThis.acquireVsCodeApi;
  const subscribers = new Set();
  let nativeApi;
  let nativeReady = false;
  let route = document.querySelector('meta[name="initial-route"]')?.content ?? '/';
  let notifyQueued = false;
  const notify = () => {
    if (notifyQueued) return;
    notifyQueued = true;
    queueMicrotask(() => {
      notifyQueued = false;
      for (const subscriber of subscribers) {
        try { subscriber({ ready: nativeReady, route }); } catch { /* Enhancement errors must not escape into React. */ }
      }
    });
  };
  globalThis.__vscodexLayerBridge = Object.freeze({
    observeRoute(path) {
      if (typeof path === 'string' && path !== route) { route = path; notify(); }
    },
    subscribe(callback) { subscribers.add(callback); notify(); return () => subscribers.delete(callback); },
    postMessage(message) {
      if (!nativeApi || !nativeReady) throw new Error('官方聊天页面尚未就绪。');
      return nativeApi.postMessage(message);
    },
  });
  globalThis.acquireVsCodeApi = function (...args) {
    const api = acquire.apply(this, args);
    nativeApi = api;
    return Object.freeze({
      getState: api.getState.bind(api),
      setState: api.setState.bind(api),
      postMessage(...messages) {
        const result = api.postMessage(...messages);
        if (messages[0]?.type === 'ready') { nativeReady = true; notify(); }
        return result;
      },
    });
  };
})();
