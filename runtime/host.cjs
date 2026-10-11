const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const REQUEST = 'vscodex-layer/request';
const RESPONSE = 'vscodex-layer/response';
const EVENT = 'vscodex-layer/event';
const STATE_KEY = 'vscodexLayer.navigationState.v1';

function cleanState(value = {}) {
  return {
    mode: value.mode === 'current' ? 'current' : 'all',
    width: Math.min(420, Math.max(180, Number(value.width) || 250)),
    collapsed: typeof value.collapsed === 'boolean' ? value.collapsed : null,
    groups: Array.isArray(value.groups) ? value.groups.filter((item) => typeof item === 'string' && item.length <= 4096).slice(0, 2000) : [],
    disabled: value.disabled === true,
  };
}

function summary(thread) {
  if (!thread || typeof thread.id !== 'string') return null;
  // Do not forward transcripts, credentials, or model configuration to the navigation.
  return { id: thread.id, title: String(thread.name || thread.preview || '未命名聊天').replace(/\s+/g, ' ').slice(0, 200),
    cwd: typeof thread.cwd === 'string' ? thread.cwd : null,
    createdAt: Number(thread.createdAt) || 0, updatedAt: Number(thread.updatedAt) || 0,
    status: typeof thread.status?.type === 'string' ? thread.status.type : 'notLoaded' };
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
  const post = (message) => { if (!disposed) Promise.resolve(webview.postMessage(message)).catch(() => {}); };
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
  function list(cursor) {
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
          limit: 50, cursor: cursor ?? null, sortKey: 'updated_at', archived: false,
          sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true,
        });
      } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function validateProject(cwd) {
    if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || cwd.includes('\0') || !path.isAbsolute(cwd)) {
      throw new Error('项目必须具有当前运行主机上的有效绝对目录。');
    }
    const directory = path.resolve(cwd);
    try {
      if (!(await fs.stat(directory)).isDirectory()) throw new Error('not a directory');
      await fs.access(directory, constants.R_OK);
    } catch { throw new Error(`项目目录不存在或无法访问：${directory}`); }
    return { cwd: directory };
  }
  async function run(method, params) {
    if (method === 'init') return { ...support(), folders: folders(),
      state: cleanState(await provider.globalState.get(STATE_KEY)), version: provider.extensionVersion };
    const environment = support();
    if (!environment.supported) throw new Error(environment.reason);
    if (method === 'list') {
      if (params.cursor != null && (typeof params.cursor !== 'string' || params.cursor.length > 16384)) throw new Error('分页参数无效。');
      const result = await list(params.cursor);
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
    if (method === 'new-project-chat') {
      if (!['/', '/extension/panel/new'].includes(params.path)) throw new Error('空白聊天入口无效。');
      const { cwd } = await validateProject(params.cwd);
      // Only navigate to a project-scoped native draft. Creation remains part of the first submission.
      const route = `${params.path}?vclProjectCwd=${encodeURIComponent(cwd)}`;
      provider.postMessageToWebview(webview, { type: 'navigate-to-route', path: route });
      return { path: route, cwd };
    }
    if (method === 'save-state') {
      await provider.globalState.update(STATE_KEY, cleanState(params.state));
      return { saved: true };
    }
    throw new Error('不支持的增强操作。');
  }
  const changedMethods = new Set(['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived',
    'thread/status/changed', 'thread/metadata/updated', 'turn/completed']);
  disposables.push(provider.codexMcpConnection.registerInternalNotificationHandler((notification) => {
    if (changedMethods.has(notification.method)) post({ type: EVENT, event: 'threads-changed' });
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
      rejectAll(new Error('聊天面板已关闭。'));
      for (const disposable of disposables) disposable.dispose();
    },
  };
  disposables.push(onDispose(() => api.dispose()));
  return api;
};
