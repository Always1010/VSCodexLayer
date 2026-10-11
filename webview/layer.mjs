import { LayerClient } from './client.mjs';
import { groupThreads, normalizePath, projectName, routeThreadId, loadAllThreads, ThreadActivity } from './core.mjs';
import { ReplyReader } from './reading.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const icons = {
  panel: ['M8 3v18', 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  refresh: ['M20 7v5h-5', 'M4 17v-5h5', 'M6.1 7a7 7 0 0 1 11.6-2L20 8', 'M4 16l2.3 3a7 7 0 0 0 11.6-2'],
  folder: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z'],
  chevron: ['m9 6 6 6-6 6'], search: ['m21 21-4.4-4.4', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z'],
  back: ['m12 5-7 7 7 7', 'M5 12h15'],
  plus: ['M12 5v14', 'M5 12h14'],
  pin: ['M16 3l5 5-4 1-4 4-1 4-5-5 4-1 4-4Z', 'm2 22 5-5'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  folderPlus: ['M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z', 'M12 10v8', 'M8 14h8'],
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
function nativeMenuOpen(trigger) {
  return trigger?.getAttribute('data-state') === 'open' || trigger?.getAttribute('aria-expanded') === 'true';
}
function nativeMenuKey(trigger, key) {
  trigger?.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
}

class Navigation {
  constructor(client, bridge, info) {
    this.client = client; this.bridge = bridge; this.info = info; this.state = info.state;
    this.threads = []; this.closed = new Set(this.state.groups); this.query = ''; this.active = null;
    this.activity = new ThreadActivity(this.state.unread);
    this.draftPath = '/';
    this.projectCwd = null; this.draftProjectCwd = null;
    this.registry = info.registry ?? { revision: 0, projects: [] };
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
    this.projectNotice = element('div', 'vcl-project-notice'); this.projectNotice.setAttribute('role', 'status');
    this.projectNotice.setAttribute('aria-live', 'polite');
    this.addProjectButton = iconButton('folderPlus', '添加项目文件夹', () => this.toggleProjectForm());
    this.addProjectButton.id = 'vcl-add-project'; this.addProjectButton.setAttribute('aria-expanded', 'false');
    this.addProjectButton.setAttribute('aria-controls', 'vcl-project-form');
    const scopeRow = element('div', 'vcl-scope-row'); scopeRow.append(this.mode, this.addProjectButton);
    search.append(icon('search'), this.search);
    controls.append(selectLabel, scopeRow, this.buildProjectForm(), search, this.projectContext, this.projectNotice);
    this.status = element('div', 'vcl-status', '正在读取聊天…');
    this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
    this.list = element('div', 'vcl-list'); this.list.setAttribute('aria-label', '项目和聊天');
    this.list.addEventListener('keydown', (event) => this.onListKey(event));
    this.list.addEventListener('scroll', () => { this.dismissNativeMenu(); this.closeProjectMenu(); });
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
    this.cleanups.push(this.bridge.setReasoningReader((method, detail) =>
      this.client.request(method, detail).catch((error) => { this.showError(error); throw error; })));
    this.reader = new ReplyReader(this.activity, () => this.active, () => { this.render(); this.persist(); });
    this.cleanups.push(() => this.reader.dispose());
    this.cleanups.push(this.bridge.subscribe(({ route }) => this.onRoute(route)));
    this.cleanups.push(this.bridge.setNewChatHandler(() => {
      if (this.draftProjectCwd !== null) this.newProjectChat(this.draftProjectCwd);
      else this.client.request('new-chat', { path: this.draftPath }).catch((error) => this.showError(error));
    }));
    this.cleanups.push(this.bridge.subscribeThreadArchived((threadId) => {
      if (this.disposed) return;
      this.threads = this.threads.filter((thread) => thread.id !== threadId);
      this.activity.acknowledge(threadId); this.activity.statuses.delete(threadId);
      if (this.active === threadId) {
        if (this.draftProjectCwd !== null) this.newProjectChat(this.draftProjectCwd);
        else this.client.request('new-chat', { path: this.draftPath }).catch((error) => this.showError(error));
      }
      this.render(); this.persist(); this.scheduleRefresh();
    }));
    this.cleanups.push(this.bridge.subscribeThreadMenuError((message) => {
      this.closeMenuAnchor(); this.showError(new Error(`官方聊天菜单加载失败：${message}`));
    }));
    this.cleanups.push(this.client.onEvent((event) => {
      if (event === 'workspace-changed') {
        this.client.request('init').then((next) => {
          if (!next.supported) { this.dispose(); showLauncher(next.reason || '当前模式暂不支持项目导航'); return; }
          this.info.folders = next.folders; this.setRegistry(next.registry); this.render();
        }).catch((error) => this.showError(error));
      } else if (event === 'threads-changed') this.scheduleRefresh();
      else if (event?.type === 'projects-changed') this.setRegistry(event);
      else if (this.activity.receive(event)) {
        if (event.threadId === this.active && ['started', 'completed'].includes(event.phase)) this.reader.reset();
        this.render(); this.persist();
      }
    }));
    const resize = () => {
      this.dismissNativeMenu(); this.closeProjectMenu(); this.layout();
    }; window.addEventListener('resize', resize);
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
  buildProjectForm() {
    this.projectForm = element('form', 'vcl-project-form'); this.projectForm.id = 'vcl-project-form'; this.projectForm.hidden = true;
    this.projectForm.setAttribute('aria-label', '添加项目文件夹');
    const label = element('label', '', '文件夹路径'); label.htmlFor = 'vcl-project-path';
    this.projectPath = element('input', 'vcl-path-input'); this.projectPath.id = 'vcl-project-path';
    this.projectPath.type = 'text'; this.projectPath.autocomplete = 'off'; this.projectPath.spellcheck = false;
    this.projectPath.placeholder = '输入绝对文件夹路径'; this.projectPath.required = true;
    this.projectPath.setAttribute('aria-describedby', 'vcl-project-help vcl-project-error');
    this.projectPath.addEventListener('input', () => this.projectFormError(''));
    const pathRow = element('div', 'vcl-path-row');
    this.pickProjectButton = iconButton('folder', '选择文件夹', () => this.pickProjectFolder());
    pathRow.append(this.projectPath, this.pickProjectButton);
    const help = element('div', 'vcl-form-help', this.info.mode === 'ssh-remote' ? '使用当前远程主机上的目录' : '使用本机上的目录');
    help.id = 'vcl-project-help';
    this.projectError = element('div', 'vcl-form-error'); this.projectError.id = 'vcl-project-error'; this.projectError.setAttribute('role', 'alert');
    const actions = element('div', 'vcl-form-actions');
    const start = element('button', 'vcl-action vcl-primary', '添加并新建聊天'); start.type = 'submit';
    const add = element('button', 'vcl-action', '仅添加'); add.type = 'button'; add.addEventListener('click', () => this.addProject(false));
    const cancel = element('button', 'vcl-action', '取消'); cancel.type = 'button'; cancel.addEventListener('click', () => this.toggleProjectForm(false));
    actions.append(start, add, cancel);
    this.projectForm.append(element('strong', '', '添加项目文件夹'), label, pathRow, help, this.projectError, actions);
    this.projectForm.addEventListener('submit', (event) => { event.preventDefault(); this.addProject(true); });
    this.projectForm.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); this.toggleProjectForm(false); }
    });
    return this.projectForm;
  }
  toggleProjectForm(open = this.projectForm.hidden) {
    if (this.projectBusy) return;
    this.dismissNativeMenu(); this.closeProjectMenu();
    this.projectForm.hidden = !open; this.addProjectButton.setAttribute('aria-expanded', String(open));
    if (open) { this.projectFormError(''); this.notifyProject(''); this.projectPath.focus(); } else this.addProjectButton.focus({ preventScroll: true });
  }
  notifyProject(message, error = false) {
    this.projectNotice.textContent = message; this.projectNotice.classList.toggle('vcl-error', error);
  }
  projectFormError(message) {
    this.projectError.textContent = message; this.projectPath.setAttribute('aria-invalid', String(!!message));
  }
  projectFormBusy(busy) {
    this.projectBusy = busy; this.projectForm.setAttribute('aria-busy', String(busy));
    for (const control of this.projectForm.querySelectorAll('button,input')) control.disabled = busy;
    this.addProjectButton.disabled = busy;
  }
  setRegistry(value) {
    if (!value || !Number.isSafeInteger(value.revision) || !Array.isArray(value.projects) || value.revision < this.registry.revision || this.disposed) return;
    this.registry = { revision: value.revision, projects: value.projects }; this.render();
  }
  async pickProjectFolder() {
    if (this.projectBusy || this.disposed) return;
    this.projectFormBusy(true); this.projectFormError('');
    try {
      const result = await this.client.request('pick-project-folder');
      if (!this.disposed && !result.cancelled) this.projectPath.value = result.cwd;
    } catch (error) { if (!this.disposed) this.projectFormError(error.message); }
    finally { if (!this.disposed) { this.projectFormBusy(false); this.projectPath.focus(); } }
  }
  async addProject(startChat) {
    if (this.projectBusy || this.disposed) return;
    if (!this.projectPath.value) { this.projectFormError('请输入当前运行主机上的绝对文件夹路径。'); this.projectPath.focus(); return; }
    this.projectFormBusy(true); this.projectFormError('');
    let saved = false;
    try {
      const result = await this.client.request('add-project', { cwd: this.projectPath.value });
      if (this.disposed) return;
      saved = true; this.setRegistry(result);
      this.state.mode = 'all'; this.mode.value = 'all'; this.query = ''; this.search.value = '';
      const key = normalizePath(result.cwd); this.closed.delete(key); this.render(); this.persist();
      this.projectForm.hidden = true; this.addProjectButton.setAttribute('aria-expanded', 'false'); this.projectPath.value = '';
      this.notifyProject(result.changed ? '已添加项目文件夹。' : '项目已存在，已定位到该项目。');
      const heading = [...this.list.querySelectorAll('.vcl-project-heading')].find((node) => node.dataset.vclKey === `project:${key}`);
      heading?.scrollIntoView({ block: 'nearest' }); heading?.focus({ preventScroll: true });
      heading?.classList.add('vcl-located');
      if (startChat) await this.client.request('new-project-chat', { path: this.draftPath, cwd: result.cwd });
    } catch (error) {
      if (!this.disposed) {
        if (saved) this.notifyProject(`项目已添加，打开聊天失败：${error.message}；可点击项目 ＋ 重试。`, true);
        else { this.projectFormError(error.message); }
      }
    } finally {
      if (!this.disposed) { this.projectFormBusy(false); if (!saved) this.projectPath.focus(); }
    }
  }
  closeProjectMenu(restoreFocus = false) {
    const menu = this.projectMenu;
    if (!menu) return;
    const key = menu.dataset.projectKey; this.projectMenuCleanup?.(); menu.remove(); this.projectMenu = null;
    if (restoreFocus && !this.disposed) {
      const heading = [...this.list.querySelectorAll('.vcl-project-heading')].find((node) => node.dataset.vclKey === key);
      (heading ?? this.addProjectButton).focus({ preventScroll: true });
    }
  }
  openProjectMenu(group, heading, point) {
    if (this.disposed || !group.path) return;
    this.dismissNativeMenu(); this.closeProjectMenu();
    const menu = element('div', 'vcl-project-menu'); menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', `${group.name} 项目操作`);
    menu.dataset.projectKey = heading.dataset.vclKey;
    const action = (text, name, callback) => {
      const button = element('button', '', text); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.dataset.action = name;
      button.addEventListener('click', () => { this.closeProjectMenu(true); callback(); }); menu.append(button);
    };
    action('复制文件夹路径', 'copy-project-path', () => this.client.request('copy-project-path', { cwd: group.path }).catch((error) => this.showError(error)));
    if (group.registered) action('移除添加记录', 'remove-project', () => this.removeProject(group));
    this.rail.append(menu); this.projectMenu = menu;
    const rect = heading.getBoundingClientRect(), size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(point?.x ?? rect.left, window.innerWidth - size.width - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(point?.y ?? rect.bottom, window.innerHeight - size.height - 4))}px`;
    const outside = (event) => { if (!menu.contains(event.target)) this.closeProjectMenu(); };
    const keyboard = (event) => {
      if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); this.closeProjectMenu(true); }
      else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const items = [...menu.querySelectorAll('button')]; const current = items.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
        items[index].focus();
      }
    };
    document.addEventListener('pointerdown', outside, true); menu.addEventListener('keydown', keyboard);
    this.projectMenuCleanup = () => { document.removeEventListener('pointerdown', outside, true); };
    menu.querySelector('button')?.focus({ preventScroll: true });
  }
  async removeProject(group) {
    try {
      const result = await this.client.request('remove-project', { cwd: group.path });
      if (this.disposed) return;
      this.setRegistry(result);
      const remaining = groupThreads(this.threads, this.info.folders, { registeredProjects: this.registry.projects, pinnedProjects: this.state.pinnedProjects }).some((item) => item.key === group.key);
      this.notifyProject(remaining ? '已移除添加记录；该项目仍有聊天、属于当前工作区或保持置顶。' : '已移除添加记录，文件夹和聊天均保留。');
      if (!this.list.contains(document.activeElement) && !this.projectForm.contains(document.activeElement)) this.addProjectButton.focus({ preventScroll: true });
    } catch (error) { if (!this.disposed) this.showError(error); }
  }
  toggleNavigation() {
    this.closeProjectMenu();
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
    this.reader.reset();
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
  toggleProjectPin(group) {
    const pins = this.state.pinnedProjects ?? [];
    this.state.pinnedProjects = group.pinned
      ? pins.filter((project) => normalizePath(project.path) !== group.key)
      : [...pins, { path: group.path, name: group.name }];
    this.render(); this.persist();
  }
  closeMenuAnchor() {
    clearTimeout(this.menuTimer); this.menuObserver?.disconnect();
    this.list?.querySelectorAll('.vcl-menu-open').forEach((row) => {
      row.classList.remove('vcl-menu-open'); row.querySelector('.vcl-chat-more')?.setAttribute('aria-expanded', 'false');
    });
    this.bridge.closeThreadMenu(); this.menuAnchor?.remove();
    this.menuAnchor = null; this.menuKey = null;
  }
  dismissNativeMenu() {
    const trigger = this.menuAnchor?.querySelector('button');
    if (nativeMenuOpen(trigger)) nativeMenuKey(trigger, 'Enter');
  }
  openChatMenu(thread, button, point) {
    if (this.disposed) return;
    if (document.querySelector('[role="dialog"], [aria-modal="true"]')) {
      this.showError(new Error('请先完成或关闭当前对话框，再打开聊天操作。')); return;
    }
    this.dismissNativeMenu();
    this.closeProjectMenu();
    this.closeMenuAnchor();
    const rect = button.getBoundingClientRect();
    const anchor = element('div', 'vcl-menu-anchor');
    anchor.style.left = `${Math.max(0, Math.min(point?.x ?? rect.left, window.innerWidth - 28))}px`;
    anchor.style.top = `${Math.max(0, Math.min(point?.y ?? rect.top, window.innerHeight - 28))}px`;
    document.body.append(anchor); this.menuAnchor = anchor; this.menuKey = `more:${thread.id}`;
    let clicked = false; let opened = false;
    const update = () => {
      if (this.menuAnchor !== anchor || this.disposed) return;
      const trigger = anchor.querySelector('button');
      if (!trigger) return;
      if (!clicked) {
        clicked = true; clearTimeout(this.menuTimer);
        requestAnimationFrame(() => { if (this.menuAnchor === anchor) nativeMenuKey(trigger, 'ArrowDown'); });
      }
      const isOpen = nativeMenuOpen(trigger);
      if (isOpen) opened = true;
      const currentButton = [...this.list.querySelectorAll('.vcl-chat-more')].find((node) => node.dataset.vclKey === this.menuKey);
      currentButton?.setAttribute('aria-expanded', String(isOpen));
      currentButton?.closest('.vcl-thread-row')?.classList.toggle('vcl-menu-open', isOpen);
      if (opened && !isOpen) requestAnimationFrame(() => {
        if (anchor.contains(document.activeElement)) currentButton?.focus({ preventScroll: true });
      });
    };
    this.menuObserver = new MutationObserver(update);
    this.menuObserver.observe(anchor, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state', 'aria-expanded'] });
    try {
      this.bridge.openThreadMenu(thread, anchor);
      this.menuTimer = setTimeout(() => {
        if (!clicked && this.menuAnchor === anchor) {
          this.closeMenuAnchor(); this.showError(new Error('官方聊天菜单未能加载，可返回原版界面操作。'));
        }
      }, 4000);
    } catch (error) { this.closeMenuAnchor(); this.showError(error); }
  }
  render() {
    if (this.disposed) return;
    const scrollTop = this.list.scrollTop;
    const focused = document.activeElement?.closest('[data-vcl-key]')?.dataset.vclKey;
    const groups = groupThreads(this.threads, this.info.folders, {
      mode: this.state.mode, query: this.query, pinnedProjects: this.state.pinnedProjects,
      registeredProjects: this.registry.projects,
    });
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
          const threadRow = element('div', `vcl-thread-row${this.active === thread.id ? ' vcl-selected' : ''}`);
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
          const more = iconButton('more', '聊天操作', () => this.openChatMenu(thread, more));
          more.addEventListener('keydown', (event) => {
            if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey
              || !['Enter', ' ', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault(); event.stopPropagation();
            if (!event.repeat) this.openChatMenu(thread, more);
          });
          more.dataset.vclKey = `more:${thread.id}`; more.classList.add('vcl-chat-more');
          more.setAttribute('aria-haspopup', 'menu');
          const menuOpen = this.menuKey === more.dataset.vclKey && nativeMenuOpen(this.menuAnchor?.querySelector('button'));
          more.setAttribute('aria-expanded', String(menuOpen)); threadRow.classList.toggle('vcl-menu-open', menuOpen);
          threadRow.addEventListener('contextmenu', (event) => {
            event.preventDefault(); this.openChatMenu(thread, more,
              event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
          });
          threadRow.append(row, more); children.append(threadRow);
        }
      }
      const projectRow = element('div', 'vcl-project-row');
      const create = iconButton('plus', group.path ? `在 ${group.name} 中新建聊天` : '无法新建聊天：未确定项目目录', () => this.newProjectChat(group.path));
      create.dataset.vclKey = `new:${group.key}`; create.classList.add('vcl-new-chat');
      create.disabled = !group.path || this.creating;
      projectRow.append(heading);
      if (group.path) {
        const pin = iconButton('pin', group.pinned ? '取消置顶项目' : '置顶项目', () => this.toggleProjectPin(group));
        pin.dataset.vclKey = `pin:${group.key}`; pin.classList.add('vcl-project-pin');
        pin.classList.toggle('vcl-pinned', group.pinned); pin.setAttribute('aria-pressed', String(group.pinned));
        projectRow.append(pin);
      }
      projectRow.append(create); section.append(projectRow, children); fragment.append(section);
      if (group.path) {
        heading.setAttribute('aria-haspopup', 'menu');
        projectRow.addEventListener('contextmenu', (event) => {
          event.preventDefault(); this.openProjectMenu(group, heading, event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined);
        });
        heading.addEventListener('keydown', (event) => {
          if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); this.openProjectMenu(group, heading); }
        });
      }
    }
    if (!groups.length) fragment.append(element('div', 'vcl-empty', this.query ? '没有匹配的项目或聊天'
      : this.state.mode === 'current' && !this.info.folders.length ? '当前窗口没有本地项目' : '暂无聊天'));
    this.list.replaceChildren(fragment); this.count.textContent = `${groups.length} 个项目 · ${visibleThreads} 个聊天`;
    this.list.scrollTop = scrollTop;
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
    const rows = [...this.list.querySelectorAll('button:not(:disabled):not(.vcl-chat-more)')];
    const index = rows.indexOf(row.closest('.vcl-thread-row')?.querySelector('.vcl-thread') ?? row);
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
    this.closeMenuAnchor();
    this.closeProjectMenu();
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
