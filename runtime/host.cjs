const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const REQUEST = 'vscodex-layer/request';
const RESPONSE = 'vscodex-layer/response';
const EVENT = 'vscodex-layer/event';
const STATE_KEY = 'vscodexLayer.navigationState.v1';
const PROJECTS_KEY = 'vscodexLayer.projects.v1';
const projectStores = new WeakMap();
const navigationStores = new WeakMap();
const validId = (value) => typeof value === 'string' && /^[\w-]{1,200}$/.test(value);

function directoryKey(directory) {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function cleanProjects(value = {}) {
  value ??= {};
  const projects = new Map();
  for (const project of Array.isArray(value.projects) ? value.projects : []) {
    const directory = project?.path;
    if (typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0') || !path.isAbsolute(directory)) continue;
    projects.set(directoryKey(directory), { path: path.resolve(directory) });
    if (projects.size === 2000) break;
  }
  return { revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    projects: [...projects.values()] };
}

function cleanState(value = {}) {
  value ??= {};
  const pins = new Map();
  for (const project of Array.isArray(value.pinnedProjects) ? value.pinnedProjects : []) {
    const directory = project?.path;
    if (typeof directory !== 'string' || directory.length > 4096 || directory.includes('\0')
      || !/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(directory) || pins.has(directory)) continue;
    pins.set(directory, { path: directory,
      name: typeof project.name === 'string' ? project.name.slice(0, 200) : '' });
    if (pins.size === 2000) break;
  }
  return {
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0,
    unreadTurns: Object.fromEntries(Object.entries(value.unreadTurns ?? {}).filter(([id, token]) => validId(id) && validId(token)).slice(-2000)),
    mode: value.mode === 'current' ? 'current' : 'all',
    width: Math.min(420, Math.max(180, Number(value.width) || 250)),
    collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : null,
    groups: Array.isArray(value.groups) ? value.groups.filter((item) => typeof item === 'string' && item.length <= 4096).slice(0, 2000) : [],
    pinnedProjects: [...pins.values()],
    disabled: value.disabled === true,
    unread: Array.isArray(value.unread) ? value.unread.filter((id) => typeof id === 'string' && /^[\w-]{1,200}$/.test(id)).slice(-2000) : [],
  };
}

function activityStatus(status) {
  return { status: typeof status?.type === 'string' ? status.type : 'notLoaded',
    activeFlags: Array.isArray(status?.activeFlags) ? status.activeFlags.filter((flag) =>
      flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') : [] };
}

function summary(thread) {
  if (!thread || typeof thread.id !== 'string') return null;
  // Do not forward transcripts, credentials, or model configuration to the navigation.
  return { id: thread.id, title: String(thread.name || thread.preview || '未命名聊天').replace(/\s+/g, ' ').slice(0, 200),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
    createdAt: Number(thread.createdAt) || 0, updatedAt: Number(thread.updatedAt) || 0,
    ...activityStatus(thread.status) };
}

function workspaceSupport(vscode, provider, isWsl, platform) {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const unsupported = (reason) => ({ supported: false, mode: 'unsupported', reason });
  if (isWsl() || vscode.env.remoteName === 'wsl') return unsupported('项目导航暂不支持 WSL 模式。');
  if (!vscode.env.remoteName) {
    return folders.every(({ uri }) => uri.scheme === 'file')
      ? { supported: true, mode: 'local', reason: null }
      : unsupported('项目导航暂不支持虚拟工作区。');
  }
  if (vscode.env.remoteName !== 'ssh-remote') return unsupported('项目导航目前仅支持本地和 Linux Remote SSH 工作区。');
  const extension = vscode.extensions?.getExtension('openai.chatgpt');
  if (platform !== 'linux' || vscode.ExtensionKind?.Workspace === undefined
    || extension?.extensionKind !== vscode.ExtensionKind.Workspace
    || provider.extensionUri?.scheme !== 'file' || extension.extensionUri?.scheme !== 'file'
    || !provider.extensionUri.fsPath || !extension.extensionUri.fsPath
    || path.resolve(provider.extensionUri.fsPath) !== path.resolve(extension.extensionUri.fsPath)) {
    return unsupported('Remote SSH 项目导航需要 Codex 扩展运行在远程 Linux 工作区宿主。');
  }
  // VS Code transforms SSH URIs into host-local file URIs before delivering them
  // to the remote extension host. Client-local files become vscode-local instead.
  if (!folders.every(({ uri }) => uri.scheme === 'file' && !uri.authority
    && typeof uri.fsPath === 'string' && path.posix.isAbsolute(uri.fsPath))) {
    return unsupported('Remote SSH 工作区必须使用当前远程宿主的文件目录。');
  }
  return { supported: true, mode: 'ssh-remote', reason: null };
}

exports.createLayerHost = function createLayerHost({ vscode, provider, webview, onDispose, isWsl, platform = process.platform }) {
  const name = `VSCodexLayer-${randomUUID()}`;
  const pending = new Map();
  const disposables = [];
  let disposed = false;
  let reading;
  let readerUri;
  let readerChanges;
  const readerKey = (detail) => JSON.stringify([detail.hostId, detail.conversationId, detail.itemId]);
  function readerDetail(value) {
    for (const key of ['hostId', 'conversationId', 'itemId']) {
      if (typeof value[key] !== 'string' || !value[key] || value[key].length > 200 || value[key].includes('\0')) {
        throw new Error('摘要阅读位置无效。');
      }
    }
    if (typeof value.content !== 'string' || value.content.length > 2 * 1024 * 1024) throw new Error('摘要正文无效或过长。');
    return { hostId: value.hostId, conversationId: value.conversationId, itemId: value.itemId,
      content: value.content, completed: value.completed === true };
  }
  function readerText() {
    return `# 思考摘要\n\n${reading?.completed ? '已完成' : '生成中 · 正文随收到的摘要更新'}\n\n${reading?.content ?? ''}`;
  }
  async function openReader(params) {
    const detail = readerDetail(params);
    if (!readerUri) {
      // A per-panel scheme prevents collisions between Codex panels and remote hosts.
      const scheme = `vscodex-reasoning-${randomUUID()}`;
      readerChanges = new vscode.EventEmitter();
      const registration = vscode.workspace.registerTextDocumentContentProvider(scheme, {
        onDidChange: readerChanges.event,
        provideTextDocumentContent: () => readerText(),
      });
      readerUri = vscode.Uri.from({ scheme, path: '/思考摘要.md' });
      disposables.push(registration, readerChanges);
    }
    reading = detail;
    readerChanges.fire(readerUri);
    await vscode.workspace.openTextDocument(readerUri);
    if (disposed) return { opened: false };
    // Use VS Code's built-in Markdown renderer in the main editor, rather than
    // adding another scrollable viewport inside the Codex sidebar. No file is written.
    await vscode.commands.executeCommand('markdown.showPreview', readerUri);
    return { opened: true };
  }
  const post = (message) => { if (!disposed) Promise.resolve(webview.postMessage(message)).catch(() => {}); };
  let projectStore = projectStores.get(provider.globalState);
  if (!projectStore) {
    projectStore = { queue: Promise.resolve(), listeners: new Set() };
    projectStores.set(provider.globalState, projectStore);
  }
  const projectsChanged = (registry) => post({ type: EVENT, event: { type: 'projects-changed', ...registry } });
  projectStore.listeners.add(projectsChanged);
  disposables.push({ dispose() { projectStore.listeners.delete(projectsChanged); } });
  async function readProjects() {
    await projectStore.queue;
    return cleanProjects(await provider.globalState.get(PROJECTS_KEY));
  }
  function changeProjects(cwd, add) {
    const operation = projectStore.queue.then(async () => {
      if (disposed) throw new Error('聊天面板已关闭。');
      const registry = cleanProjects(await provider.globalState.get(PROJECTS_KEY));
      const index = registry.projects.findIndex((project) => directoryKey(project.path) === directoryKey(cwd));
      const changed = add ? index < 0 : index >= 0;
      if (changed) {
        if (add && registry.projects.length >= 2000) throw new Error('手动项目数量已达上限，请先移除不再使用的添加记录。');
        if (add) registry.projects.push({ path: cwd }); else registry.projects.splice(index, 1);
        registry.revision += 1;
        await provider.globalState.update(PROJECTS_KEY, registry);
        for (const listener of projectStore.listeners) listener(registry);
      }
      return { ...registry, cwd: index >= 0 && add ? registry.projects[index].path : cwd, changed };
    });
    // Failed writes must not block later edits from this or another panel.
    projectStore.queue = operation.catch(() => {});
    return operation;
  }
  let navigationStore = navigationStores.get(provider.globalState);
  if (!navigationStore) {
    navigationStore = { queue: Promise.resolve(), listeners: new Set(), turns: new Map(), tokens: new WeakMap() };
    navigationStores.set(provider.globalState, navigationStore);
  }
  const stateChanged = (state) => post({ type: EVENT, event: { type: 'navigation-state-changed', state } });
  navigationStore.listeners.add(stateChanged);
  disposables.push({ dispose() { navigationStore.listeners.delete(stateChanged); } });
  async function readState() {
    await navigationStore.queue;
    return cleanState(await provider.globalState.get(STATE_KEY));
  }
  function changeState(operations, internal = false) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 2000) {
      return Promise.reject(new Error('导航状态操作无效。'));
    }
    const operation = navigationStore.queue.then(async () => {
      if (disposed) throw new Error('聊天面板已关闭。');
      let state = cleanState(await provider.globalState.get(STATE_KEY));
      const turns = new Map(navigationStore.turns);
      for (const edit of operations) {
        if (edit?.type === 'set' && ['mode', 'width', 'collapsed', 'disabled'].includes(edit.key)) {
          state = cleanState({ ...state, [edit.key]: edit.value });
        } else if (edit?.type === 'pin' && typeof edit.enabled === 'boolean') {
          const project = cleanState({ pinnedProjects: [edit.project] }).pinnedProjects[0];
          if (!project) continue;
          const key = directoryKey(project.path);
          const index = state.pinnedProjects.findIndex((item) => directoryKey(item.path) === key);
          if (edit.enabled && index < 0) state.pinnedProjects.push(project);
          if (!edit.enabled && index >= 0) state.pinnedProjects.splice(index, 1);
        } else if (edit?.type === 'group' && typeof edit.key === 'string' && edit.key.length <= 4096 && typeof edit.closed === 'boolean') {
          const groups = new Set(state.groups);
          if (edit.closed) groups.add(edit.key); else groups.delete(edit.key);
          state.groups = [...groups];
        } else if (edit?.type === 'acknowledge' && validId(edit.threadId)) {
          if ((state.unreadTurns[edit.threadId] ?? null) === (edit.turnToken ?? null)) {
            state.unread = state.unread.filter((id) => id !== edit.threadId);
          }
        } else if (internal && edit?.type === 'turn' && validId(edit.threadId) && validId(edit.turnToken)) {
          const previous = turns.get(edit.threadId);
          if (previous?.seen.includes(edit.turnToken) || previous?.token === edit.turnToken && (previous.phase === edit.phase || previous.phase === 'completed')) continue;
          const seen = previous && previous.token !== edit.turnToken ? [...previous.seen, previous.token].slice(-8) : previous?.seen ?? [];
          turns.set(edit.threadId, { token: edit.turnToken, phase: edit.phase, seen });
          // Keep the latest token after acknowledgement so duplicate completions cannot resurrect unread.
          const duplicate = edit.phase === 'completed' && state.unreadTurns[edit.threadId] === edit.turnToken
            && previous?.phase !== 'started';
          const wasUnread = state.unread.includes(edit.threadId);
          state.unreadTurns[edit.threadId] = edit.turnToken;
          state.unread = state.unread.filter((id) => id !== edit.threadId);
          if (edit.phase === 'completed' && !duplicate) state.unread.push(edit.threadId);
          else if (duplicate && wasUnread) state.unread.push(edit.threadId);
        } else throw new Error('导航状态操作无效。');
      }
      state = cleanState(state); state.revision += 1;
      await provider.globalState.update(STATE_KEY, state);
      navigationStore.turns = new Map([...turns].slice(-2000));
      for (const listener of navigationStore.listeners) listener(state);
      return { saved: true, state };
    });
    navigationStore.queue = operation.catch(() => {});
    return operation;
  }
  const folders = () => (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name, path: folder.uri.fsPath, scheme: folder.uri.scheme, authority: folder.uri.authority,
  }));
  const support = () => workspaceSupport(vscode, provider, isWsl, platform);
  const rejectAll = (error) => {
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      provider.codexMcpConnection.abandonRequest(name, id);
      request.reject(error);
    }
    pending.clear();
  };
  disposables.push(provider.codexMcpConnection.registerProvider(name, {
    onResult(message) {
      const id = String(message.id);
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || '聊天列表读取失败。'));
      else request.resolve(message.result);
    },
    onFatalError(error) { rejectAll(error); },
  }));
  function list(cursor, archived) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        provider.codexMcpConnection.abandonRequest(name, id);
        reject(new Error('读取聊天超时，请稍后刷新。'));
      }, 25000);
      pending.set(id, { resolve, reject, timer });
      try {
        provider.codexMcpConnection.sendRequest(name, id, 'thread/list', {
          limit: 50, cursor: cursor ?? null, sortKey: 'updated_at', archived,
          sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true,
        });
      } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function projectPath(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
      throw new Error('项目必须具有当前运行主机上的有效绝对目录。');
    }
    return path.resolve(cwd);
  }
  async function validateProject(cwd) {
    const directory = projectPath(cwd);
    try {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
      await fs.access(directory, constants.R_OK);
    } catch { throw new Error(`项目目录不存在或无法访问：${directory}`); }
    return { cwd: directory };
  }
  async function run(method, params) {
    if (method === 'init') return { ...support(), folders: folders(),
      state: await readState(), registry: await readProjects(), version: provider.extensionVersion };
    const environment = support();
    if (!environment.supported) throw new Error(environment.reason);
    if (method === 'open-reasoning-view') return openReader(params);
    if (method === 'update-reasoning-view') {
      const detail = readerDetail(params);
      if (!reading || readerKey(detail) !== readerKey(reading)) return { updated: false };
      if (reading.content !== detail.content || reading.completed !== detail.completed) {
        reading = detail;
        readerChanges.fire(readerUri);
      }
      return { updated: true };
    }
    if (method === 'list') {
      if (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 16384)) throw new Error('分页参数无效。');
      if (params.archived !== undefined && typeof params.archived !== 'boolean') throw new Error('归档筛选参数无效。');
      const result = await list(params.cursor, params.archived === true);
      if (!Array.isArray(result?.data)) throw new Error('官方聊天列表格式发生变化。');
      return { data: result.data.map(summary).filter(Boolean), nextCursor: result.nextCursor ?? null };
    }
    if (method === 'navigate') {
      if (typeof params.threadId !== 'string' || !/^[\w-]{1,200}$/.test(params.threadId)) throw new Error('聊天编号无效。');
      // Target the originating webview, rather than the provider's sidebar-only helper.
      provider.postMessageToWebview(webview, { type: 'navigate-to-route', path: `/local/${params.threadId}` });
      return { threadId: params.threadId };
    }
    if (method === 'new-chat') {
      if (!['/', '/extension/panel/new'].includes(params.path)) throw new Error('空白聊天入口无效。');
      provider.postMessageToWebview(webview, { type: 'navigate-to-route', path: params.path });
      return { path: params.path };
    }
    if (method === 'validate-project') return validateProject(params.cwd);
    if (method === 'pick-project-folder') {
      const selected = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, title: '添加项目文件夹', openLabel: '选择项目文件夹' });
      if (!selected?.length || disposed) return { cancelled: true };
      const uri = selected[0];
      if (uri.scheme !== 'file' || environment.mode === 'ssh-remote' && uri.authority) {
        throw new Error('请选择当前运行主机上的文件夹。');
      }
      return validateProject(uri.fsPath);
    }
    if (method === 'add-project') {
      const { cwd } = await validateProject(params.cwd);
      return changeProjects(cwd, true);
    }
    if (method === 'remove-project') return changeProjects(projectPath(params.cwd), false);
    if (method === 'copy-project-path') {
      await vscode.env.clipboard.writeText(projectPath(params.cwd));
      return { copied: true };
    }
    if (method === 'new-project-chat') {
      if (!['/', '/extension/panel/new'].includes(params.path)) throw new Error('空白聊天入口无效。');
      const { cwd } = await validateProject(params.cwd);
      // Only navigate to a project-scoped native draft. Creation remains part of the first submission.
      const route = `${params.path}?vclProjectCwd=${encodeURIComponent(cwd)}`;
      provider.postMessageToWebview(webview, { type: 'navigate-to-route', path: route });
      return { path: route, cwd };
    }
    if (method === 'save-state') {
      return changeState(params.operations);
    }
    throw new Error('不支持的增强操作。');
  }
  const changedMethods = new Set(['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived',
    'thread/metadata/updated']);
  const replies = new Map();
  const replyId = (item) => item?.type === 'agentMessage' && item.phase !== 'commentary'
    && typeof item.id === 'string' && /^[\w-]{1,200}$/.test(item.id) ? item.id : null;
  disposables.push(provider.codexMcpConnection.registerInternalNotificationHandler((notification) => {
    const { method, params = {} } = notification;
    const threadId = method === 'thread/started' ? params.thread?.id : params.threadId;
    if (typeof threadId === 'string' && /^[\w-]{1,200}$/.test(threadId)) {
      if (method === 'turn/started') replies.delete(threadId);
      if (method === 'item/completed' && typeof params.turnId === 'string'
        && /^[\w-]{1,200}$/.test(params.turnId) && replyId(params.item)) {
        replies.set(threadId, { turnId: params.turnId, itemId: replyId(params.item) });
      }
      let event;
      if (method === 'thread/status/changed' || method === 'thread/started') {
        event = { type: 'thread-activity', threadId, phase: 'status',
          ...activityStatus(method === 'thread/started' ? params.thread.status : params.status) };
      } else if (method === 'turn/started' || method === 'turn/completed') {
        event = { type: 'thread-activity', threadId, phase: method === 'turn/started' ? 'started' : 'completed',
          status: method === 'turn/started' ? 'active' : params.turn?.status === 'failed' ? 'systemError' : 'idle', activeFlags: [] };
        if (method === 'turn/completed') {
          const remembered = replies.get(threadId);
          const itemId = Array.isArray(params.turn?.items) ? params.turn.items.map(replyId).filter(Boolean).at(-1) : null;
          const completedId = itemId ?? (remembered?.turnId === params.turn?.id ? remembered?.itemId : null);
          if (completedId) event.replyItemId = completedId;
          replies.delete(threadId);
        }
      }
      if (event?.phase === 'started' || event?.phase === 'completed') {
        let turnToken = params.turn?.id ?? params.turnId;
        if (!validId(turnToken)) {
          turnToken = navigationStore.tokens.get(notification);
          if (!turnToken) {
            turnToken = event.phase === 'completed' ? navigationStore.turns.get(threadId)?.token : null;
            turnToken ??= randomUUID(); navigationStore.tokens.set(notification, turnToken);
          }
        }
        const activityEvent = { ...event, turnToken };
        changeState([{ type: 'turn', threadId, turnToken, phase: event.phase }], true).then(({ state }) => {
          if (state.unreadTurns[threadId] === turnToken) post({ type: EVENT, event: {
            ...activityEvent, unread: state.unread.includes(threadId),
          } });
        }).catch((error) => {
          post({ type: EVENT, event: activityEvent });
          post({ type: EVENT, event: { type: 'state-save-error', message: error.message } });
        });
      } else if (event) post({ type: EVENT, event });
    }
    if (changedMethods.has(notification.method)) post({ type: EVENT, event: {
      type: 'threads-changed', method, ...(validId(threadId) ? { threadId } : {}),
    } });
  }));
  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => post({ type: EVENT, event: 'workspace-changed' })));
  const api = {
    handle(message) {
      if (message?.type !== REQUEST) return false;
      if (disposed || typeof message.id !== 'string' || message.id.length > 100) return true;
      Promise.resolve().then(() => run(message.method, message.params ?? {})).then(
        (result) => post({ type: RESPONSE, id: message.id, result }),
        (error) => post({ type: RESPONSE, id: message.id, error: error.message || '增强操作失败。' }),
      );
      return true;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      reading = undefined;
      rejectAll(new Error('聊天面板已关闭。'));
      for (const disposable of disposables) disposable.dispose();
    },
  };
  disposables.push(onDispose(() => api.dispose()));
  return api;
};
