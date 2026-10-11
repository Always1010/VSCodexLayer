/* Runs before the official module. The official app remains the sole acquirer of its VS Code API. */
(() => {
  if (globalThis.__vscodexLayerBridge || typeof globalThis.acquireVsCodeApi !== 'function') return;
  const acquire = globalThis.acquireVsCodeApi;
  const subscribers = new Set();
  const reasoningSubscribers = new Set();
  let reasoningEnabled = false;
  let nativeApi;
  let nativeReady = false;
  let newChatHandler;
  let projectValidator;
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
    reasoningEnabled() { return reasoningEnabled; },
    subscribeReasoning(callback) {
      reasoningSubscribers.add(callback);
      return () => reasoningSubscribers.delete(callback);
    },
    setReasoningEnabled(enabled) {
      if (reasoningEnabled === (enabled === true)) return;
      reasoningEnabled = enabled === true;
      for (const callback of reasoningSubscribers) {
        try { callback(); } catch { /* A failed enhancement subscriber must not affect the native app. */ }
      }
    },
    observeRoute(path) {
      if (typeof path === 'string' && path !== route) { route = path; notify(); }
    },
    subscribe(callback) { subscribers.add(callback); notify(); return () => subscribers.delete(callback); },
    setNewChatHandler(handler) {
      newChatHandler = handler;
      return () => { if (newChatHandler === handler) newChatHandler = undefined; };
    },
    setProjectValidator(handler) { projectValidator = handler; },
    validateProject(cwd) {
      if (!projectValidator) return Promise.reject(new Error('项目目录校验尚未就绪，请稍后重试。'));
      return projectValidator(cwd);
    },
    projectCwd(value) { return value?.kind === 'new' ? value.vclProjectCwd : undefined; },
    projectRoute(pathname, routeTemplate, search = '') {
      if (pathname !== '/' && pathname !== '/extension/panel/new') return null;
      const params = new URLSearchParams(search);
      if (!params.has('vclProjectCwd')) return null;
      const cwd = params.get('vclProjectCwd');
      // Keep invalid project markers scoped too: submission must reject them instead of falling back.
      const windows = /^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith('\\\\') || cwd.startsWith('//');
      // Preserve existing Windows draft identities; Linux directories are case sensitive.
      const key = windows ? cwd.replaceAll('\\', '/').replace(/\/$/, '').toLowerCase()
        : cwd === '/' ? cwd : cwd.replace(/\/+$/, '');
      return { pathname, routeTemplate, search, routeKind: pathname === '/' ? 'home' : 'new-thread-panel',
        projectContext: null, vclProjectCwd: cwd, vclDraftKey: `vscodex-layer-new:${pathname}:${encodeURIComponent(key)}` };
    },
    resumeDraft(options) {
      if (!nativeReady || !newChatHandler) return false;
      // Explicit prefills, project selections and other specialized actions remain native.
      if (options != null && (typeof options !== 'object' || Object.entries(options).some(([key, value]) =>
        value !== undefined && !['selectChat', 'startInSidebar', 'replace', 'onNavigate', 'freshDraft'].includes(key)))) return false;
      try { newChatHandler(); return true; } catch { return false; }
    },
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
