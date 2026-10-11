import { LayerClient } from './client.mjs';
import { groupThreads, normalizePath, projectName, routeThreadId, loadAllThreads, ThreadActivity } from './core.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const icons = {
  panel: ['M8 3v18', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-2L20 8', 'M4 16l2.3 3a7 7 0 0 0 11.6-2'],
  folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  chevron: ['m9 6 6 6-6 6'], search: ['m21 21-4.4-4.4', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  back: ['m12 5-7 7 7 7', 'M5 12h15'],
  plus: ['M12 5v14', 'M5 12h14'],
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name, className = '') {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `vcl-icon ${className}` })) svg.setAttribute(key, value);
  for (const d of icons[name]) { const part = document.createElementNS(SVG, 'path'); part.setAttribute('d', d); svg.append(part); }
  return svg;
}
function iconButton(name, label, callback) {
  const button = element('button', 'vcl-icon-button');
  button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(name)); button.addEventListener('click', callback);
  return button;
}

class Navigation {
  constructor(client, bridge, info) {
    this.client = client; this.bridge = bridge; this.info = info; this.state = info.state;
    this.threads = []; this.closed = new Set(this.state.groups); this.query = ''; this.active = null;
    this.activity = new ThreadActivity(this.state.unread);
    this.draftPath = '/';
    this.projectCwd = null; this.draftProjectCwd = null;
    this.abort = new AbortController(); this.cleanups = []; this.disposed = false;
  }
  mount() {
    this.rail = element('aside'); this.rail.id = 'vcl-navigation'; this.rail.setAttribute('aria-label', '项目聊天导航');
    const header = element('div', 'vcl-header');
    header.append(element('strong', 'vcl-heading', '项目聊天'));
    this.refreshButton = iconButton('refresh', '刷新聊天列表', () => this.refresh());
    const toggle = iconButton('panel', '收起或展开项目导航 (Alt+/)', () => this.toggleNavigation());
    toggle.setAttribute('aria-keyshortcuts', 'Alt+/');
    toggle.id = 'vcl-toggle'; header.append(this.refreshButton, toggle);
    const controls = element('div', 'vcl-controls');
    const selectLabel = element('label', 'vcl-sr-only', '显示项目范围'); selectLabel.htmlFor = 'vcl-mode';
    this.mode = element('select', 'vcl-select'); this.mode.id = 'vcl-mode';
    for (const [value, label] of [['all', '全部项目'], ['current', '仅当前项目']]) {
      const option = element('option', '', label); option.value = value; this.mode.append(option);
    }
    this.mode.value = this.state.mode;
    this.mode.addEventListener('change', () => { this.state.mode = this.mode.value; this.render(); this.persist(); });
    const search = element('div', 'vcl-search');
    this.search = element('input', 'vcl-input'); this.search.type = 'search'; this.search.placeholder = '搜索项目或聊天';
    this.search.setAttribute('aria-label', '搜索项目或聊天');
    this.search.addEventListener('input', () => { this.query = this.search.value; this.render(); });
    this.projectContext = element('div', 'vcl-project-context'); this.projectContext.setAttribute('role', 'status');
    search.append(icon('search'), this.search); controls.append(selectLabel, this.mode, search, this.projectContext);
    this.status = element('div', 'vcl-status', '正在读取聊天…');
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.list = element('div', 'vcl-list'); this.list.setAttribute('aria-label', '项目和聊天');
    this.list.addEventListener('keydown', (event) => this.onListKey(event));
    const footer = element('div', 'vcl-footer'); this.count = element('span', 'vcl-count');
    footer.append(this.count, iconButton('back', '返回原版界面', () => this.disable()));
    this.resizeHandle = element('div', 'vcl-resize'); this.resizeHandle.tabIndex = 0;
    for (const [key, value] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical',
      'aria-label': '调整项目导航宽度', 'aria-valuemin': '180', 'aria-valuemax': '420' })) this.resizeHandle.setAttribute(key, value);
    this.resizeHandle.addEventListener('pointerdown', (event) => this.startResize(event));
    this.resizeHandle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault(); this.state.width = Math.min(420, Math.max(180, this.state.width + (event.key === 'ArrowLeft' ? -10 : 10)));
      this.layout(); this.persist();
    });
    this.rail.append(header, controls, this.status, this.list, footer, this.resizeHandle);
    document.body.append(this.rail); document.body.classList.add('vcl-enabled');
    this.bridge.setReasoningEnabled(true);
    this.cleanups.push(this.bridge.subscribe(({ route }) => this.onRoute(route)));
    this.cleanups.push(this.bridge.setNewChatHandler(() => {
      if (this.draftProjectCwd !== null) this.newProjectChat(this.draftProjectCwd);
      else this.client.request('new-chat', { path: this.draftPath }).catch((error) => this.showError(error));
    }));
    this.cleanups.push(this.client.onEvent((event) => {
      if (event === 'workspace-changed') {
        this.client.request('init').then((next) => {
          if (!next.supported) { this.dispose(); showLauncher(next.reason || '当前模式暂不支持项目导航'); return; }
          this.info.folders = next.folders; this.render();
        }).catch((error) => this.showError(error));
      } else if (event === 'threads-changed') this.scheduleRefresh();
      else if (this.activity.receive(event)) { this.render(); this.persist(); }
    }));
    const resize = () => this.layout(); window.addEventListener('resize', resize);
    this.cleanups.push(() => window.removeEventListener('resize', resize));
    const keydown = (event) => {
      if (event.defaultPrevented || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || (event.key !== '/' && event.code !== 'Slash')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!event.repeat) this.toggleNavigation();
    };
    window.addEventListener('keydown', keydown, true);
    this.cleanups.push(() => window.removeEventListener('keydown', keydown, true));
    this.layout(); this.render(); this.refresh();
  }
  isCollapsed() { return this.state.collapsed ?? window.innerWidth < 640; }
  toggleNavigation() {
    this.state.collapsed = !this.isCollapsed(); this.layout(); this.persist();
    if (this.state.collapsed && this.rail.contains(document.activeElement)) this.rail.querySelector('#vcl-toggle').focus();
  }
  layout() {
    if (this.disposed) return;
    const collapsed = this.isCollapsed();
    const width = collapsed ? 42 : Math.max(180, Math.min(this.state.width, window.innerWidth - 280));
    document.body.style.setProperty('--vcl-rail-width', `${width}px`); this.rail.classList.toggle('vcl-collapsed', collapsed);
    const toggle = this.rail.querySelector('#vcl-toggle'); toggle.title = `${collapsed ? '展开' : '收起'}项目导航 (Alt+/)`;
    toggle.setAttribute('aria-label', toggle.title); toggle.setAttribute('aria-expanded', String(!collapsed));
    this.resizeHandle.setAttribute('aria-valuenow', String(Math.round(width)));
  }
  onRoute(route) {
    const url = new URL(route, 'https://vscodex-layer.local');
    const projectCwd = ['/', '/extension/panel/new'].includes(url.pathname) ? url.searchParams.get('vclProjectCwd') : null;
    const changedProject = this.projectCwd !== projectCwd;
    this.projectCwd = projectCwd;
    if (url.pathname === '/' || url.pathname === '/extension/panel/new') {
      this.draftPath = url.pathname; this.draftProjectCwd = projectCwd;
    }
    const next = routeThreadId(route);
    if (this.active === next && !changedProject) return;
    if (next && this.activity.acknowledge(next)) this.persist();
    this.active = next; const thread = this.threads.find((item) => item.id === next);
    if (thread) this.closed.delete(normalizePath(thread.cwd));
    this.render(); if (next && !thread) this.scheduleRefresh();
  }
  async newProjectChat(cwd) {
    if (this.creating || this.disposed) return;
    this.creating = true; this.render();
    try { await this.client.request('new-project-chat', { path: this.draftPath, cwd }); }
    catch (error) { this.showError(error); }
    finally { this.creating = false; if (!this.disposed) this.render(); }
  }
  async refresh() {
    if (this.disposed) return;
    if (this.loading) { this.refreshAgain = true; return; }
    this.loading = true; this.refreshButton.disabled = true; this.refreshButton.classList.add('vcl-loading');
    this.status.classList.remove('vcl-error');
    try {
      const threads = await loadAllThreads((cursor) => this.client.request('list', { cursor }), {
        signal: this.abort.signal,
        onPage: (partial) => {
          this.status.textContent = `正在读取聊天… ${partial.length}`;
          if (!this.hasLoaded) { this.threads = partial; this.render(); }
        },
      });
      if (this.disposed) return;
      const firstLoad = !this.hasLoaded;
      const knownActive = this.threads.some((thread) => thread.id === this.active);
      this.threads = threads; this.hasLoaded = true;
      const active = threads.find((thread) => thread.id === this.active);
      if ((firstLoad || !knownActive) && active) this.closed.delete(normalizePath(active.cwd));
      this.status.textContent = ''; this.render();
    } catch (error) { if (!this.disposed) this.showError(error); }
    finally {
      this.loading = false;
      if (!this.disposed) {
        this.refreshButton.disabled = false; this.refreshButton.classList.remove('vcl-loading');
        if (this.refreshAgain) { this.refreshAgain = false; this.scheduleRefresh(); }
      }
    }
  }
  scheduleRefresh() {
    if (this.disposed) return;
    clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh(), 600);
  }
  showError(error) {
    if (this.disposed) return;
    this.status.classList.add('vcl-error'); this.status.textContent = error.message || '聊天列表读取失败，可刷新重试或返回原版界面。';
  }
  render() {
    if (this.disposed) return;
    const focused = document.activeElement?.closest('[data-vcl-key]')?.dataset.vclKey;
    const groups = groupThreads(this.threads, this.info.folders, { mode: this.state.mode, query: this.query });
    const fragment = document.createDocumentFragment(); let visibleThreads = 0;
    this.projectContext.textContent = this.projectCwd === null ? '' : `新聊天 · ${projectName(this.projectCwd)}`;
    this.projectContext.title = this.projectCwd ?? '';
    for (const [index, group] of groups.entries()) {
      visibleThreads += group.threads.length; const section = element('section', 'vcl-project');
      const closed = !this.query && this.closed.has(group.key);
      const heading = element('button', 'vcl-project-heading'); heading.type = 'button';
      heading.dataset.vclKey = `project:${group.key}`; heading.title = group.path || '无法确定工作目录';
      if (this.projectCwd !== null && group.key === normalizePath(this.projectCwd)) {
        heading.classList.add('vcl-selected'); heading.setAttribute('aria-current', 'page');
      }
      heading.setAttribute('aria-expanded', String(!closed)); heading.setAttribute('aria-controls', `vcl-group-${index}`);
      heading.append(icon('chevron', closed ? '' : 'vcl-open'), icon('folder'), element('span', 'vcl-label', group.name));
      if (group.current) heading.append(element('span', 'vcl-current', '当前'));
      heading.append(element('span', 'vcl-group-count', String(group.total)));
      if (closed && group.threads.some((thread) => this.activity.indicator(thread)?.kind === 'attention')) {
        heading.append(this.activityDot({ kind: 'attention', label: '项目中有聊天需要查看' }));
        heading.setAttribute('aria-label', `${group.name}，项目中有聊天需要查看`);
      }
      heading.addEventListener('click', () => {
        if (this.closed.has(group.key)) this.closed.delete(group.key); else this.closed.add(group.key);
        this.render(); this.persist();
      });
      const children = element('div', 'vcl-threads'); children.id = `vcl-group-${index}`; children.hidden = closed;
      if (!closed) {
        if (!group.threads.length) children.append(element('div', 'vcl-empty-project', '暂无聊天'));
        for (const thread of group.threads) {
          const row = element('button', `vcl-thread${this.active === thread.id ? ' vcl-selected' : ''}`);
          row.type = 'button'; row.dataset.vclKey = `thread:${thread.id}`;
          row.title = `${thread.title}\n${thread.cwd || '未分类'}`;
          if (this.active === thread.id) row.setAttribute('aria-current', 'page');
          row.append(element('span', 'vcl-label', thread.title));
          const indicator = this.activity.indicator(thread);
          if (indicator) {
            row.append(this.activityDot(indicator)); row.title += `\n${indicator.label}`;
            row.setAttribute('aria-label', `${thread.title}，${indicator.label}`);
          }
          row.addEventListener('click', () => {
            if (this.activity.acknowledge(thread.id)) { this.render(); this.persist(); }
            this.client.request('navigate', { threadId: thread.id }).catch((error) => this.showError(error));
          });
          children.append(row);
        }
      }
      const projectRow = element('div', 'vcl-project-row');
      const create = iconButton('plus', group.path ? `在 ${group.name} 中新建聊天` : '无法新建聊天：未确定项目目录', () => this.newProjectChat(group.path));
      create.dataset.vclKey = `new:${group.key}`; create.classList.add('vcl-new-chat');
      create.disabled = !group.path || this.creating;
      projectRow.append(heading, create); section.append(projectRow, children); fragment.append(section);
    }
    if (!groups.length) fragment.append(element('div', 'vcl-empty', this.query ? '没有匹配的项目或聊天'
      : this.state.mode === 'current' && !this.info.folders.length ? '当前窗口没有本地项目' : '暂无聊天'));
    this.list.replaceChildren(fragment); this.count.textContent = `${groups.length} 个项目 · ${visibleThreads} 个聊天`;
    if (focused) [...this.list.querySelectorAll('[data-vcl-key]')].find((node) => node.dataset.vclKey === focused)?.focus({ preventScroll: true });
  }
  activityDot({ kind, label }) {
    const dot = element('span', `vcl-activity${kind === 'attention' ? ' vcl-attention' : ''}`);
    dot.title = label; dot.setAttribute('aria-hidden', 'true'); return dot;
  }
  onListKey(event) {
    const row = event.target.closest('button');
    if (!row || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (row.classList.contains('vcl-project-heading') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const expanded = row.getAttribute('aria-expanded') === 'true';
      if ((event.key === 'ArrowLeft' && expanded) || (event.key === 'ArrowRight' && !expanded)) row.click();
      else if (event.key === 'ArrowRight') row.closest('.vcl-project')?.querySelector('.vcl-threads button')?.focus();
      return;
    }
    if (event.key === 'ArrowLeft') { row.closest('.vcl-project')?.querySelector('.vcl-project-heading')?.focus(); return; }
    const rows = [...this.list.querySelectorAll('button:not(:disabled)')]; const index = rows.indexOf(row);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : index + (event.key === 'ArrowUp' ? -1 : 1);
    rows[Math.min(rows.length - 1, Math.max(0, target))]?.focus();
  }
  startResize(event) {
    if (event.button !== 0 || this.isCollapsed()) return;
    event.preventDefault(); const pointer = event.pointerId; this.resizeHandle.setPointerCapture(pointer);
    const move = (next) => { this.state.width = Math.min(420, Math.max(180, next.clientX)); this.layout(); };
    const end = () => {
      this.resizeHandle.removeEventListener('pointermove', move); this.resizeHandle.removeEventListener('pointerup', end);
      this.resizeHandle.removeEventListener('lostpointercapture', end);
      if (this.resizeHandle.hasPointerCapture(pointer)) this.resizeHandle.releasePointerCapture(pointer);
      this.persist();
    };
    this.resizeHandle.addEventListener('pointermove', move); this.resizeHandle.addEventListener('pointerup', end);
    this.resizeHandle.addEventListener('lostpointercapture', end); this.cleanups.push(end);
  }
  persist() {
    if (this.disposed) return;
    this.state.unread = [...this.activity.unread];
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => {
      this.client.request('save-state', { state: { ...this.state, groups: [...this.closed] } }).catch((error) => this.showError(error));
    }, 200);
  }
  async disable() {
    this.state.unread = [...this.activity.unread];
    try { await this.client.request('save-state', { state: { ...this.state, groups: [...this.closed], disabled: true } }); }
    catch (error) { this.showError(error); return; }
    this.dispose(); showLauncher('启用项目导航');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(); clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer);
    this.bridge.setReasoningEnabled(false);
    for (const cleanup of this.cleanups) cleanup();
    this.rail?.remove(); document.body.classList.remove('vcl-enabled'); document.body.style.removeProperty('--vcl-rail-width');
    this.client.dispose();
  }
}

const bridge = globalThis.__vscodexLayerBridge;
// Submission validation remains available when only the navigation layout is disabled.
const projectClient = bridge ? new LayerClient(bridge) : null;
bridge?.setProjectValidator((cwd) => projectClient.request('validate-project', { cwd }));
let started = false;
let navigation;
function showLauncher(label) {
  document.getElementById('vcl-launcher')?.remove();
  const button = iconButton('panel', label, () => start(true)); button.id = 'vcl-launcher'; document.body.append(button);
}
async function start(force = false) {
  if (started) return;
  started = true; const client = new LayerClient(bridge);
  try {
    const info = await client.request('init');
    if (!info.supported) { client.dispose(); started = false; showLauncher(info.reason || '当前模式暂不支持项目导航'); return; }
    if (info.state.disabled && !force) { client.dispose(); started = false; showLauncher('启用项目导航'); return; }
    info.state.disabled = false;
    if (force) await client.request('save-state', { state: info.state });
    document.getElementById('vcl-launcher')?.remove(); navigation = new Navigation(client, bridge, info);
    const dispose = navigation.dispose.bind(navigation); navigation.dispose = () => { dispose(); started = false; };
    navigation.mount();
  } catch (error) {
    navigation?.dispose(); client.dispose(); started = false; console.warn('VSCodexLayer:', error.message);
    showLauncher(`项目导航未加载：${error.message}；点击重试`);
  }
}
bridge?.subscribe(({ ready }) => { if (ready && !started && !document.getElementById('vcl-launcher')) start(); });
window.addEventListener('pagehide', () => { navigation?.dispose(); projectClient?.dispose(); }, { once: true });
