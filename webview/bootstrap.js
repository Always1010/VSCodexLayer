/* Runs before the official module. The official app remains the sole acquirer of its VS Code API. */
(() => {
  if (globalThis.__vscodexLayerBridge || typeof globalThis.acquireVsCodeApi !== 'function') return;
  const acquire = globalThis.acquireVsCodeApi;
  const subscribers = new Set();
  const reasoningSubscribers = new Set();
  const menuSubscribers = new Set();
  const menuSurfaces = new Set();
  const archiveSubscribers = new Set();
  const archiveActions = new Map();
  const menuErrorSubscribers = new Set();
  const agentDetailSurfaces = new Map();
  const agentDetailSubscribers = new Set();
  const agentDetailErrors = new Set();
  let agentDetailTarget = null;
  let agentDetailSequence = 0;
  let agentDetailSelect;
  const notifyAgentDetail = () => {
    for (const callback of agentDetailSubscribers) { try { callback(); } catch { /* Isolate native render subscribers. */ } }
  };
  let menuTarget = null;
  let menuSequence = 0;
  const notifyMenu = () => {
    for (const callback of menuSubscribers) { try { callback(); } catch { /* Isolate native render subscribers. */ } }
  };
  let reasoningEnabled = false;
  let nativeApi;
  let nativeReady = false;
  let newChatHandler;
  let projectValidator;
  let reasoningReader;
  let readingKey;
  let readingReady;
  const reasoningDetail = (props) => {
    const itemId = props?.item?.sourceItemId ?? props?.item?.searchItemId;
    if (typeof itemId !== 'string' || typeof props?.conversationId !== 'string'
      || typeof props?.item?.content !== 'string') return null;
    return { hostId: props.hostId ?? 'local', conversationId: props.conversationId,
      itemId, content: props.item.content, completed: props.item.completed === true };
  };
  const reasoningKey = (detail) => JSON.stringify([detail.hostId, detail.conversationId, detail.itemId]);
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
    registerAgentDetailSurface(surface, actions) {
      agentDetailSurfaces.set(surface, actions);
      return () => {
        agentDetailSurfaces.delete(surface);
        if (agentDetailTarget?.surface === surface) { agentDetailTarget = null; notifyAgentDetail(); }
      };
    },
    hasAgentDetail() { return agentDetailSurfaces.size > 0; },
    subscribeAgentDetail(callback) { agentDetailSubscribers.add(callback); return () => agentDetailSubscribers.delete(callback); },
    agentDetailTarget() { return agentDetailTarget; },
    async openAgentDetail(detail, container) {
      const surface = agentDetailSurfaces.keys().next().value;
      if (!surface) throw new Error('官方子 Agent 详情尚未就绪。');
      if (![detail?.rootId, detail?.threadId].every((id) => typeof id === 'string' && /^[\w-]{1,200}$/.test(id))
        || !container?.isConnected) throw new Error('子 Agent 详情位置无效。');
      const target = { surface, container, rootId: detail.rootId, threadId: detail.threadId,
        token: ++agentDetailSequence, loading: true };
      agentDetailTarget = target; notifyAgentDetail();
      try {
        await agentDetailSurfaces.get(surface).prepare(target.rootId, target.threadId);
        if (agentDetailTarget !== target) return { opened: false };
        agentDetailTarget = { ...target, loading: false }; notifyAgentDetail();
        return { opened: true };
      } catch (error) {
        if (agentDetailTarget === target) { agentDetailTarget = null; notifyAgentDetail(); }
        throw error;
      }
    },
    closeAgentDetail() { if (agentDetailTarget) { agentDetailTarget = null; notifyAgentDetail(); } },
    subscribeAgentDetailError(callback) { agentDetailErrors.add(callback); return () => agentDetailErrors.delete(callback); },
    agentDetailError(message, token) {
      queueMicrotask(() => {
        if (agentDetailTarget?.token !== token) return;
        for (const callback of agentDetailErrors) { try { callback(message); } catch { /* Preserve the parent chat. */ } }
      });
    },
    setAgentDetailSelectHandler(handler) {
      agentDetailSelect = handler; return () => { if (agentDetailSelect === handler) agentDetailSelect = undefined; };
    },
    selectAgentDetail(threadId) { agentDetailSelect?.(threadId); },
    subscribeThreadMenu(callback) { menuSubscribers.add(callback); return () => menuSubscribers.delete(callback); },
    threadMenuTarget() { return menuTarget; },
    registerThreadMenuSurface(surface) {
      menuSurfaces.add(surface);
      return () => {
        menuSurfaces.delete(surface);
        if (menuTarget?.surface === surface) { menuTarget = null; notifyMenu(); }
      };
    },
    openThreadMenu(thread, container) {
      const surface = menuSurfaces.values().next().value;
      if (!surface) throw new Error('官方聊天菜单尚未就绪，请稍后重试。');
      if (!thread || typeof thread.id !== 'string' || !/^[\w-]{1,200}$/.test(thread.id)
        || !container?.isConnected) throw new Error('聊天菜单位置无效。');
      menuTarget = { surface, container, token: ++menuSequence, thread: { id: thread.id, title: String(thread.title ?? ''),
        cwd: typeof thread.cwd === 'string' ? thread.cwd : null, hostId: 'local' } };
      notifyMenu();
    },
    closeThreadMenu() { if (menuTarget) { menuTarget = null; notifyMenu(); } },
    subscribeThreadMenuError(callback) { menuErrorSubscribers.add(callback); return () => menuErrorSubscribers.delete(callback); },
    threadMenuError(error, token) {
      queueMicrotask(() => {
        if (token != null && menuTarget?.token !== token) return;
        for (const callback of menuErrorSubscribers) { try { callback(error); } catch { /* Isolate navigation error reporting. */ } }
      });
    },
    filterThreadMenu(items) {
      const allowed = new Set(['rename-thread', 'share-thread', 'copy-deeplink', 'copy-conversation-markdown',
        'copy-working-directory', 'archive-thread']);
      const filter = (values) => values.flatMap((item) => {
        if (item.type === 'separator') return [];
        if (allowed.has(item.id)) return [item];
        const submenu = item.submenu && filter(item.submenu);
        return submenu?.length ? [{ ...item, submenu }] : [];
      });
      const result = filter(items);
      const archive = result.findIndex((item) => item.id === 'archive-thread');
      if (archive > 0) result.splice(archive, 0, { id: 'vcl-archive-separator', type: 'separator' });
      return result;
    },
    subscribeThreadArchived(callback) { archiveSubscribers.add(callback); return () => archiveSubscribers.delete(callback); },
    threadArchived(threadId) {
      for (const callback of archiveSubscribers) { try { callback(threadId); } catch { /* Keep native success handling intact. */ } }
    },
    registerArchiveActions(surface, actions) {
      archiveActions.set(surface, actions);
      return () => archiveActions.delete(surface);
    },
    restoreArchivedThread(thread) {
      if (!thread || typeof thread.id !== 'string' || !/^[\w-]{1,200}$/.test(thread.id)) {
        return Promise.reject(new Error('聊天编号无效。'));
      }
      const actions = archiveActions.values().next().value;
      if (!actions) return Promise.reject(new Error('官方恢复操作尚未就绪，请稍后重试。'));
      const target = { id: thread.id };
      return Promise.resolve().then(() => actions.restore(target));
    },
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
    setReasoningReader(handler) {
      reasoningReader = handler;
      return () => {
        if (reasoningReader !== handler) return;
        reasoningReader = undefined; readingKey = undefined; readingReady = undefined;
      };
    },
    openReasoningView(props) {
      const detail = reasoningDetail(props);
      if (!reasoningEnabled || !reasoningReader || !detail) return;
      const handler = reasoningReader;
      readingKey = reasoningKey(detail);
      readingReady = Promise.resolve(handler('open-reasoning-view', detail));
      readingReady.catch(() => { /* The navigation handler reports open failures. */ });
    },
    updateReasoningView(props) {
      const detail = reasoningDetail(props);
      if (!reasoningEnabled || !reasoningReader || !detail || reasoningKey(detail) !== readingKey) return;
      const handler = reasoningReader;
      // Opening can involve an asynchronous VS Code command; never send an update before it.
      const key = readingKey;
      readingReady?.then(() => {
        if (reasoningReader === handler && readingKey === key && reasoningEnabled) {
          return handler('update-reasoning-view', detail);
        }
      }).catch(() => { /* The navigation handler reports reader failures. */ });
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
