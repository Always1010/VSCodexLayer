export function normalizePath(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  let text = value.trim();
  if (/^file:/i.test(text)) {
    try {
      const url = new URL(text);
      text = (url.hostname ? `//${url.hostname}` : '') + decodeURIComponent(url.pathname);
      text = text.replace(/^\/([a-z]:\/)/i, '$1');
    } catch { return ''; }
  }
  text = text.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '');
  const windows = /^[a-z]:\//i.test(text) || text.startsWith('//');
  const prefix = text.startsWith('//') ? '//' : text.startsWith('/') ? '/' : '';
  const parts = text.slice(prefix.length).split('/').filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    if (part === '.') continue;
    if (part === '..' && normalized.length > (windows && !prefix ? 1 : 0)) normalized.pop();
    else if (part !== '..') normalized.push(part);
  }
  text = prefix + normalized.join('/');
  if (/^[a-z]:$/i.test(text)) text += '/';
  return windows ? text.toLowerCase() : text;
}

export function projectName(cwd) {
  const normalized = normalizePath(cwd);
  if (!normalized) return '未分类';
  const parts = String(cwd).replaceAll('\\', '/').replace(/\/$/, '').split('/').filter(Boolean);
  return parts.at(-1) || normalized;
}

export function groupThreads(threads, folders = [], { mode = 'all', query = '' } = {}) {
  const groups = new Map();
  const current = new Set(folders.map((folder) => normalizePath(folder.path)).filter(Boolean));
  for (const folder of folders) {
    const key = normalizePath(folder.path);
    if (key) groups.set(key, { key, name: folder.name || projectName(folder.path), path: folder.path,
      current: true, threads: [], latest: 0 });
  }
  for (const thread of threads) {
    const key = normalizePath(thread.cwd);
    if (!groups.has(key)) groups.set(key, { key, name: projectName(thread.cwd), path: thread.cwd,
      current: current.has(key), threads: [], latest: 0 });
    const group = groups.get(key);
    group.threads.push(thread);
    group.latest = Math.max(group.latest, thread.updatedAt || thread.createdAt || 0);
  }
  const term = query.trim().toLocaleLowerCase();
  return [...groups.values()]
    .filter((group) => mode !== 'current' || group.current)
    .map((group) => {
      const projectMatches = !term || `${group.name} ${group.path ?? ''}`.toLocaleLowerCase().includes(term);
      const visible = projectMatches ? group.threads : group.threads.filter((thread) => thread.title.toLocaleLowerCase().includes(term));
      return { ...group, total: group.threads.length, threads: [...visible].sort((a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)) };
    })
    .filter((group) => !term || `${group.name} ${group.path ?? ''}`.toLocaleLowerCase().includes(term) || group.threads.length)
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(!a.key) - Number(!b.key)
      || b.latest - a.latest || a.name.localeCompare(b.name, 'zh-CN'));
}

export function routeThreadId(route) {
  const match = /^\/local\/([\w-]+)(?:[/?#]|$)/.exec(route ?? '');
  return match?.[1] ?? null;
}

export async function loadAllThreads(fetchPage, { signal, onPage = () => {} } = {}) {
  const threads = new Map();
  const cursors = new Set();
  let cursor = null;
  do {
    signal?.throwIfAborted();
    const page = await fetchPage(cursor);
    signal?.throwIfAborted();
    if (!Array.isArray(page?.data)) throw new Error('官方聊天列表格式发生变化。');
    for (const thread of page.data) {
      if (typeof thread?.id !== 'string') continue;
      const previous = threads.get(thread.id);
      if (!previous || (thread.updatedAt || 0) >= (previous.updatedAt || 0)) threads.set(thread.id, thread);
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) {
      throw new Error('分页游标异常，已停止读取，避免重复请求。');
    }
    if (cursor !== null) cursors.add(cursor);
    onPage([...threads.values()]);
  } while (cursor !== null);
  return [...threads.values()];
}
