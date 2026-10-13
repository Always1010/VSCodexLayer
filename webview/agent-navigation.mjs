import { routeThreadId } from './core.mjs';

// The native inline agent links also change the route. Observe the official
// router rather than requiring every caller to use an enhancement click handler.
export class AgentNavigation {
  constructor(client, bridge, { element, iconButton }) {
    this.client = client; this.bridge = bridge; this.element = element; this.iconButton = iconButton;
    this.sequence = 0; this.snapshots = new Map(); this.abort = new AbortController();
    this.bar = element('nav', 'vcl-agent-return'); this.bar.id = 'vcl-agent-return'; this.bar.hidden = true;
    this.bar.setAttribute('aria-label', '子 Agent 返回导航');
    document.body.append(this.bar);
    const remember = () => this.remember();
    for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, remember, { capture: true, signal: this.abort.signal });
    this.unsubscribe = bridge.subscribe(({ route }) => this.onRoute(route));
  }
  remember() {
    if (!this.threadId) return;
    const scroller = document.querySelector('#root .thread-scroll-container');
    this.snapshots.delete(this.threadId);
    this.snapshots.set(this.threadId, { path: this.route, scrollTop: scroller?.scrollTop });
    if (this.snapshots.size > 50) this.snapshots.delete(this.snapshots.keys().next().value);
  }
  async onRoute(route) {
    if (route === this.route) return;
    this.route = route; this.threadId = routeThreadId(route);
    const sequence = ++this.sequence;
    this.clear();
    if (!this.threadId) return;
    try {
      const result = await this.client.request('ancestry', { threadId: this.threadId });
      if (this.disposed || sequence !== this.sequence) return;
      this.ancestry = result;
      this.renderReturn(result);
      this.onAncestry?.(result);
    } catch (error) {
      if (!this.disposed && sequence === this.sequence) this.onError?.(error);
    }
  }
  renderReturn({ thread, ancestors, complete }) {
    if (!ancestors.length) return;
    const parent = ancestors[0], root = complete ? ancestors.at(-1) : null;
    const back = this.iconButton('back', `返回父聊天：${parent.title}`, () => this.open(parent.id));
    back.id = 'vcl-agent-back';
    const label = this.element('span', 'vcl-agent-breadcrumb', `${parent.title} › ${thread.title}`);
    this.bar.append(back, label);
    if (root && root.id !== parent.id) {
      const home = this.element('button', 'vcl-agent-root', '主聊天'); home.type = 'button';
      home.title = `返回主聊天：${root.title}`; home.addEventListener('click', () => this.open(root.id)); this.bar.append(home);
    }
    this.bar.hidden = false; document.body.classList.add('vcl-agent-child');
  }
  async open(threadId) {
    const snapshot = this.snapshots.get(threadId);
    try {
      await this.client.request('navigate', { threadId, ...(snapshot ? { path: snapshot.path } : {}) });
      if (!this.disposed && snapshot?.scrollTop !== undefined) this.restoreScroll(threadId, snapshot.scrollTop);
    } catch (error) { if (!this.disposed) this.onError?.(error); }
  }
  restoreScroll(threadId, top) {
    this.stopRestore?.();
    const observer = new MutationObserver(() => attempt());
    const stop = () => { observer.disconnect(); clearTimeout(timer); this.stopRestore = null;
      document.removeEventListener('wheel', stop, true); document.removeEventListener('pointerdown', stop, true); };
    const attempt = () => {
      if (this.threadId !== threadId) return;
      const scroller = document.querySelector('#root .thread-scroll-container');
      // Wait for the target transcript, not the previous route's still-mounted DOM.
      if (scroller && [...scroller.querySelectorAll('[data-vcl-reply-thread]')]
        .some((node) => node.dataset.vclReplyThread === threadId) && scroller.scrollHeight >= top + scroller.clientHeight) {
        scroller.scrollTop = top; stop();
      }
    };
    const timer = setTimeout(stop, 2000); this.stopRestore = stop;
    observer.observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true });
    document.addEventListener('wheel', stop, true); document.addEventListener('pointerdown', stop, true); attempt();
  }
  clear() {
    this.ancestry = null; this.bar.hidden = true; this.bar.replaceChildren(); document.body.classList.remove('vcl-agent-child');
  }
  dispose() {
    this.disposed = true; this.sequence++; this.unsubscribe(); this.abort.abort(); this.stopRestore?.(); this.clear(); this.bar.remove();
  }
}
