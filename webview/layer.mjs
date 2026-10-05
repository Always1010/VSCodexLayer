import { LayerClient } from './client.mjs';
import { groupThreads, normalizePath, routeThreadId, loadAllThreads } from './core.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const icons = {
  panel: ['M8 3v18', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-2L20 8', 'M4 16l2.3 3a7 7 0 0 0 11.6-2'],
  folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  chevron: ['m9 6 6 6-6 6'], search: ['m21 21-4.4-4.4', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  back: ['m12 5-7 7 7 7', 'M5 12h15'],
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
    this.draftPath = '/';
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
    search.append(icon('search'), this.search); controls.append(selectLabel, this.mode, search);
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
    this.cleanups.push(this.bridge.subscribe(({ route }) => this.onRoute(route)));
    this.cleanups.push(this.bridge.setNewChatHandler(() => {
      this.client.request('new-chat', { path: this.draftPath }).catch((error) => this.showError(error));
    }));
    this.cleanups.push(this.client.onEvent((event) => {
      if (event === 'workspace-changed') {
        this.client.request('init').then((next) => {
          if (!next.supported) { this.dispose(); showLauncher('当前模式暂不支持项目导航'); return; }
          this.info.folders = next.folders; this.render();
        }).catch((error) => this.showError(error));
      } else if (event === 'threads-changed') this.scheduleRefresh();
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
    if (route === '/' || route === '/extension/panel/new') this.draftPath = route;
    const next = routeThreadId(route);
    document.body.classList.toggle('vcl-local-chat', next !== null);
    if (this.active === next) return;
    this.active = next; const thread = this.threads.find((item) => item.id === next);
    if (thread) this.closed.delete(normalizePath(thread.cwd));
    this.render(); if (next && !thread) this.scheduleRefresh();
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
      this.threads = threads; this.hasLoaded = true;
      const active = threads.find((thread) => thread.id === this.active);
      if (firstLoad && active) this.closed.delete(normalizePath(active.cwd));
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
    for (const [index, group] of groups.entries()) {
      visibleThreads += group.threads.length; const section = element('section', 'vcl-project');
      const closed = !this.query && this.closed.has(group.key);
      const heading = element('button', 'vcl-project-heading'); heading.type = 'button';
      heading.dataset.vclKey = `project:${group.key}`; heading.title = group.path || '无法确定工作目录';
      heading.setAttribute('aria-expanded', String(!closed)); heading.setAttribute('aria-controls', `vcl-group-${index}`);
      heading.append(icon('chevron', closed ? '' : 'vcl-open'), icon('folder'), element('span', 'vcl-label', group.name));
      if (group.current) heading.append(element('span', 'vcl-current', '当前'));
      heading.append(element('span', 'vcl-group-count', String(group.total)));
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
          if (thread.status === 'active' || thread.status === 'running') {
            const activity = element('span', 'vcl-activity'); activity.title = '正在运行'; row.append(activity);
          }
          row.append(element('span', 'vcl-label', thread.title));
          row.addEventListener('click', () => this.client.request('navigate', { threadId: thread.id }).catch((error) => this.showError(error)));
          children.append(row);
        }
      }
      section.append(heading, children); fragment.append(section);
    }
    if (!groups.length) fragment.append(element('div', 'vcl-empty', this.query ? '没有匹配的项目或聊天'
      : this.state.mode === 'current' && !this.info.folders.length ? '当前窗口没有本地项目' : '暂无聊天'));
    this.list.replaceChildren(fragment); this.count.textContent = `${groups.length} 个项目 · ${visibleThreads} 个聊天`;
    if (focused) [...this.list.querySelectorAll('[data-vcl-key]')].find((node) => node.dataset.vclKey === focused)?.focus({ preventScroll: true });
  }
  onListKey(event) {
    const row = event.target.closest('button');
    if (!row || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (row.classList.contains('vcl-project-heading') && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const expanded = row.getAttribute('aria-expanded') === 'true';
      if ((event.key === 'ArrowLeft' && expanded) || (event.key === 'ArrowRight' && !expanded)) row.click();
      else if (event.key === 'ArrowRight') row.nextElementSibling?.querySelector('button')?.focus();
      return;
    }
    if (event.key === 'ArrowLeft') { row.closest('.vcl-project')?.querySelector('.vcl-project-heading')?.focus(); return; }
    const rows = [...this.list.querySelectorAll('button')]; const index = rows.indexOf(row);
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
    clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => {
      this.client.request('save-state', { state: { ...this.state, groups: [...this.closed] } }).catch((error) => this.showError(error));
    }, 200);
  }
  async disable() {
    try { await this.client.request('save-state', { state: { ...this.state, groups: [...this.closed], disabled: true } }); }
    catch (error) { this.showError(error); return; }
    this.dispose(); showLauncher('启用项目导航');
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.abort.abort(); clearTimeout(this.refreshTimer); clearTimeout(this.saveTimer);
    for (const cleanup of this.cleanups) cleanup();
    this.rail?.remove(); document.body.classList.remove('vcl-enabled', 'vcl-local-chat'); document.body.style.removeProperty('--vcl-rail-width');
    this.client.dispose();
  }
}

const bridge = globalThis.__vscodexLayerBridge;
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
    if (!info.supported) { client.dispose(); started = false; showLauncher('第一版仅支持本地工作区'); return; }
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
window.addEventListener('pagehide', () => navigation?.dispose(), { once: true });
