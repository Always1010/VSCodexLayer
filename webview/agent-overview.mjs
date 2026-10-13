import { AgentCatalog } from './agent-core.mjs';

export class AgentOverview {
  constructor(client, bridge, navigation, { element, iconButton, icon }) {
    Object.assign(this, { client, bridge, navigation, element, iconButton, icon });
    this.catalog = new AgentCatalog(); this.sequence = 0; this.scope = 'current';
    this.detailSequence = 0;
    this.abort = new AbortController();
    this.tools = element('div', 'vcl-agent-tools'); this.tools.id = 'vcl-agent-tools'; this.tools.hidden = true;
    this.trigger = element('button', 'vcl-agent-trigger'); this.trigger.type = 'button';
    this.trigger.setAttribute('aria-controls', 'vcl-agent-panel'); this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.addEventListener('click', () => this.setOpen(!this.opened)); this.tools.append(this.trigger);
    this.panel = element('aside', 'vcl-agent-panel'); this.panel.id = 'vcl-agent-panel'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', '子 Agent 调用概览');
    document.body.append(this.tools, this.panel);
    this.unsubscribe = client.onEvent((event) => {
      if (this.catalog.receive(event)) this.render();
    });
    this.removeDetailError = bridge.subscribeAgentDetailError?.((message) => {
      if (!this.detail || this.disposed) return;
      this.detail.loading = false; this.detail.error = message; bridge.closeAgentDetail(); this.render();
    });
    this.removeDetailTarget = bridge.subscribeAgentDetail?.(() => {
      if (!this.disposed && this.detail && !this.detail.loading && !this.detail.error && !bridge.agentDetailTarget()) {
        this.detail.error = '官方详情连接已关闭，请打开完整聊天。'; this.render();
      }
    });
    this.removeDetailSelect = bridge.setAgentDetailSelectHandler?.((id) => this.selectNested(id));
    const options = { signal: this.abort.signal };
    window.addEventListener('resize', () => this.layout(), options);
    document.addEventListener('pointerdown', (event) => {
      if (this.opened && !this.pinned && !this.panel.contains(event.target) && !this.tools.contains(event.target)) this.setOpen(false, false);
    }, options);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && this.opened && this.panel.contains(event.target)
        && !document.querySelector('[aria-modal="true"], [role="dialog"]')) { event.preventDefault(); this.setOpen(false); }
    }, options);
    navigation.onAncestry = (result) => this.setContext(result);
    navigation.onRouteChange = (id) => {
      if (!this.root || id !== this.root.id && !this.catalog.rows(this.root.id).some((row) => row.id === id)) {
        this.sequence++; this.root = null; this.setOpen(false, false); this.render();
      }
    };
  }
  async setContext({ thread, ancestors, complete }) {
    const root = complete ? ancestors.at(-1) ?? thread : thread;
    if (this.root?.id === root.id) { this.render(); return; }
    this.root = root; this.opened = false; this.pinned = false; this.scope = 'current';
    this.clearDetail();
    await this.load();
  }
  async loadIndex() {
    if (this.indexComplete) return;
    if (this.indexPromise) return this.indexPromise;
    this.indexPromise = (async () => {
      for (const archived of [false, true]) {
        let cursor = null; const seen = new Set();
        do {
          if (this.disposed) return;
          const result = await this.client.request('agent-page', { cursor, archived });
          if (this.disposed) return;
          this.catalog.page(result.data); this.render();
          cursor = result.nextCursor;
          if (cursor != null) {
            if (seen.has(cursor)) throw new Error('子 Agent 分页游标重复，列表尚未完整加载。');
            seen.add(cursor);
          }
        } while (cursor != null);
      }
      this.indexComplete = true;
    })();
    try { await this.indexPromise; } finally { this.indexPromise = null; }
  }
  async load(refresh = false) {
    if (!this.root) return;
    const rootId = this.root.id, sequence = ++this.sequence;
    this.loading = true; this.error = null;
    if (refresh) this.indexComplete = false;
    this.render();
    const history = async (id) => {
      const result = await this.client.request('agent-history', { threadId: id });
      if (this.disposed || sequence !== this.sequence) return;
      this.catalog.history(id, result.turns); this.render();
    };
    // Start the root history and index independently; consume both failures.
    const results = await Promise.allSettled([history(rootId), this.loadIndex()]);
    if (this.disposed || sequence !== this.sequence) return;
    try {
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      const loaded = new Set([rootId]);
      // Only hydrate call history for agents which themselves have descendants.
      // Complete child transcripts remain the native detail renderer's job.
      for (;;) {
        const parents = [...new Set(this.catalog.rows(rootId).map((row) => row.parentThreadId))].filter((id) => !loaded.has(id));
        if (!parents.length) break;
        for (const id of parents) {
          loaded.add(id); await history(id);
          if (this.disposed || sequence !== this.sequence) return;
        }
      }
    } catch (error) { this.error = error.message || '子 Agent 读取失败，请重试。'; }
    this.loading = false; this.render();
  }
  setOpen(open, focus = true) {
    this.opened = open; if (!open) { this.pinned = false; this.clearDetail(); }
    this.render();
    if (focus) (open ? this.panel.querySelector('button') : this.trigger)?.focus({ preventScroll: true });
  }
  layout() {
    const rail = parseFloat(getComputedStyle(document.body).getPropertyValue('--vcl-rail-width')) || 0;
    const docked = this.opened && this.pinned && window.innerWidth - rail >= 900;
    document.body.classList.toggle('vcl-agents-pinned', docked);
    this.panel.classList.toggle('vcl-docked', docked);
  }
  render() {
    if (this.disposed) return;
    const all = this.root ? this.catalog.rows(this.root.id) : [];
    const rows = this.root ? this.catalog.rows(this.root.id, this.scope) : [];
    const visible = !!this.root && (all.length > 0 || !!this.error || !!this.opened);
    this.tools.hidden = !visible; document.body.classList.toggle('vcl-agents-present', visible);
    this.trigger.replaceChildren(this.icon('agents'), this.element('span', '', `子 Agent ${all.length || (this.error ? '?' : '…')}`));
    const running = all.filter((row) => row.taskStatus === 'running').length;
    if (running) this.trigger.append(this.element('span', 'vcl-agent-muted', `· ${running} 运行中`));
    this.trigger.title = this.trigger.getAttribute('aria-label') ?? '';
    this.trigger.setAttribute('aria-label', `查看子 Agent：${all.length} 个${this.loading || this.error ? '，尚未完整加载' : ''}，${running} 个运行中`);
    this.trigger.title = this.trigger.getAttribute('aria-label');
    this.trigger.setAttribute('aria-expanded', String(!!this.opened));
    this.panel.hidden = !this.opened || !visible;
    const signature = this.detail ? [this.detailSequence, this.detail.loading, this.detail.error, !!this.pinned].join('|') : null;
    // Keep the native portal container attached during routine status updates;
    // moving it would discard keyboard focus and text selection in the transcript.
    if (signature && signature === this.detailSignature) { this.layout(); return; }
    this.detailSignature = signature;
    const focused = this.panel.contains(document.activeElement) ? document.activeElement.dataset.agentKey : null;
    const scroll = this.panel.querySelector('.vcl-agent-list')?.scrollTop ?? 0;
    const header = this.element('div', 'vcl-agent-panel-header');
    const button = (name, label, key, callback) => { const node = this.iconButton(name, label, callback); node.dataset.agentKey = key; return node; };
    if (this.detail) header.append(button('back', '返回子 Agent 概览', 'detail-back', () => {
      this.clearDetail(); this.render(); this.panel.querySelector('button')?.focus({ preventScroll: true });
    }));
    header.append(this.element('strong', '', this.detail?.row.name ?? '子 Agent'));
    const pin = button('pin', this.pinned ? '取消固定子 Agent 面板' : '固定子 Agent 面板（宽窗口使用侧栏）', 'pin', () => {
      this.pinned = !this.pinned; this.render();
    }); pin.setAttribute('aria-pressed', String(!!this.pinned));
    if (this.detail) header.append(button('open', '在主区域打开完整子聊天', 'detail-open', () => this.openFullThread(this.detail.row)));
    header.append(button('refresh', this.detail ? '重新加载子聊天' : '刷新子 Agent', 'refresh', () => this.detail ? this.openAgent(this.detail.row) : this.load(true)), pin,
      button('close', '关闭子 Agent 面板', 'close', () => this.setOpen(false)));
    const context = this.element('div', 'vcl-agent-context', this.root?.title ?? ''); context.title = context.textContent;
    this.panel.classList.toggle('vcl-detail', !!this.detail);
    if (this.detail) {
      const detail = this.detail, notice = this.element('div', 'vcl-agent-detail-notice');
      if (detail.loading) { notice.textContent = '正在加载官方子聊天…'; notice.setAttribute('role', 'status'); }
      if (detail.error) {
        const error = this.element('div', 'vcl-agent-error', `子聊天侧栏加载失败：${detail.error}`); error.setAttribute('role', 'alert'); notice.append(error);
        const full = this.element('button', 'vcl-agent-retry', '打开完整聊天'); full.type = 'button'; full.dataset.agentKey = 'detail-fallback';
        full.addEventListener('click', () => this.openFullThread(detail.row)); notice.append(full);
      }
      const model = this.element('div', 'vcl-agent-context', [detail.row.model, detail.row.reasoningEffort].filter(Boolean).join(' · '));
      this.panel.replaceChildren(header, context, model, notice, detail.body);
      if (focused) [...this.panel.querySelectorAll('[data-agent-key]')].find((node) => node.dataset.agentKey === focused)?.focus({ preventScroll: true });
      this.layout(); return;
    }
    const filter = this.element('div', 'vcl-agent-filters');
    for (const [value, label] of [['current', '本轮'], ['all', '整个聊天']]) {
      const node = this.element('button', '', label); node.type = 'button'; node.dataset.agentKey = value;
      node.setAttribute('aria-pressed', String(this.scope === value));
      node.addEventListener('click', () => { this.scope = value; this.render(); }); filter.append(node);
    }
    const counts = this.element('div', 'vcl-agent-counts', `${this.loading || this.error ? '已发现 ' : ''}${rows.length} 个 · ${rows.filter((row) => row.taskStatus === 'running').length} 运行中 · ${rows.filter((row) => row.taskStatus === 'completed').length} 已完成`);
    counts.setAttribute('role', 'status');
    const list = this.element('div', 'vcl-agent-list'); list.setAttribute('aria-busy', String(!!this.loading));
    if (this.loading) list.append(this.element('div', 'vcl-agent-muted', '正在补齐调用记录…'));
    if (this.error) {
      const error = this.element('div', 'vcl-agent-error', this.error); error.setAttribute('role', 'alert'); list.append(error);
      const retry = this.element('button', 'vcl-agent-retry', '重试'); retry.type = 'button'; retry.dataset.agentKey = 'retry';
      retry.addEventListener('click', () => this.load(true)); list.append(retry);
    }
    if (!rows.length && !this.loading && !this.error) list.append(this.element('div', 'vcl-agent-muted', this.scope === 'current' ? '本轮没有子 Agent 调用，可查看整个聊天。' : '没有子 Agent 调用。'));
    for (const row of rows) {
      const item = this.element('button', 'vcl-agent-row'); item.type = 'button'; item.dataset.agentKey = row.id;
      item.style.paddingInlineStart = `${10 + Math.min(row.depth, 5) * 14}px`;
      const line = this.element('span', 'vcl-agent-row-title');
      line.append(this.element('strong', '', row.name), this.element('span', `vcl-agent-status vcl-agent-${row.taskStatus}`, row.statusLabel));
      item.append(line);
      if (row.task) item.append(this.element('span', 'vcl-agent-task', row.task));
      if (row.model) item.append(this.element('span', 'vcl-agent-muted', `${row.model}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ''}`));
      const created = new Date((row.createdAt ?? 0) * 1000);
      if (row.createdAt > 0 && Number.isFinite(created.getTime())) {
        const time = this.element('time', 'vcl-agent-muted', `创建于 ${created.toLocaleString()}`);
        time.dateTime = created.toISOString(); item.append(time);
      }
      item.title = `${row.name}，${row.statusLabel}${row.task ? `\n${row.task}` : ''}`;
      item.addEventListener('click', () => this.openAgent(row)); list.append(item);
    }
    this.panel.replaceChildren(header, context, filter, counts, list); list.scrollTop = scroll;
    if (focused) [...this.panel.querySelectorAll('[data-agent-key]')].find((node) => node.dataset.agentKey === focused)?.focus({ preventScroll: true });
    this.layout();
  }
  async openAgent(row) {
    if (!this.bridge.hasAgentDetail?.()) { this.openFullThread(row); return; }
    this.clearDetail(); const sequence = this.detailSequence;
    const body = this.element('div', 'vcl-agent-native-detail');
    this.detail = { row, body, loading: true }; this.opened = true; this.render();
    try {
      const result = await this.bridge.openAgentDetail({ rootId: this.root.id, threadId: row.id }, body);
      if (this.disposed || sequence !== this.detailSequence) return;
      if (!result.opened) throw new Error('官方详情连接已关闭，请打开完整聊天。');
      this.detail.loading = false; this.render();
    } catch (error) {
      if (this.disposed || sequence !== this.detailSequence) return;
      this.detail.loading = false; this.detail.error = error.message || '请打开完整聊天查看。'; this.render();
    }
  }
  async selectNested(threadId) {
    if (!this.detail || !this.root) return;
    const sequence = this.detailSequence, rootId = this.root.id;
    try {
      const ancestry = await this.client.request('ancestry', { threadId });
      if (this.disposed || sequence !== this.detailSequence) return;
      if (!ancestry.ancestors.some((thread) => thread.id === rootId)) throw new Error('子聊天不属于当前主聊天。');
      await this.openAgent(this.catalog.rows(rootId).find((row) => row.id === threadId)
        ?? { id: threadId, name: ancestry.thread.title });
    } catch (error) {
      if (!this.disposed && sequence === this.detailSequence) {
        this.detail.error = error.message; this.bridge.closeAgentDetail(); this.render();
      }
    }
  }
  openFullThread(row) {
    this.navigation.remember(); this.navigation.open(row.id); this.setOpen(false, false);
  }
  clearDetail() {
    this.detailSequence++; this.detail = null; this.bridge.closeAgentDetail?.();
  }
  dispose() {
    this.disposed = true; this.sequence++; this.unsubscribe(); this.abort.abort();
    this.clearDetail(); this.removeDetailError?.(); this.removeDetailTarget?.(); this.removeDetailSelect?.();
    this.navigation.onAncestry = null; this.navigation.onRouteChange = null;
    this.tools.remove(); this.panel.remove();
    document.body.classList.remove('vcl-agents-present', 'vcl-agents-pinned');
  }
}
