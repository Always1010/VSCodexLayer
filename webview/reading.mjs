// A scroll event alone may be caused by native follow/restore behavior. Require a
// recent trusted reading gesture and bind the receipt to the exact completed reply.
export class ReplyReader {
  constructor(activity, activeThread, onRead) {
    this.activity = activity; this.activeThread = activeThread; this.onRead = onRead;
    this.abort = new AbortController();
    const listen = (target, name, handler) => target.addEventListener(name, handler,
      { capture: true, passive: true, signal: this.abort.signal });
    for (const name of ['wheel', 'pointerdown', 'keydown']) listen(document, name, (event) => this.interact(event));
    listen(document, 'pointermove', (event) => {
      if (event.isTrusted && event.buttons && this.intent) {
        this.intent.until = Date.now() + 2000; this.check();
      }
    });
    listen(document, 'scroll', (event) => { if (event.target === this.intent?.scroller) this.check(); });
    listen(window, 'blur', () => this.reset());
    listen(document, 'visibilitychange', () => this.reset());
  }
  interact(event) {
    if (!event.isTrusted) return;
    const target = event.target instanceof Element ? event.target : null;
    if (event.type === 'keydown' && (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      || target?.closest('input, textarea, select, [contenteditable="true"]'))) return;
    const scroller = target?.closest('.thread-scroll-container');
    const threadId = this.activeThread();
    const completion = this.activity.completedReplies.get(threadId);
    if (!scroller || !completion?.itemId || !this.activity.unread.has(threadId)) return;
    if (this.intent?.scroller !== scroller || this.intent?.completion !== completion) {
      this.reset();
      this.intent = { scroller, threadId, completion };
      this.observer = new MutationObserver(() => this.check());
      this.observer.observe(scroller, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['data-vcl-reply-completed', 'data-vcl-reply-item'] });
    }
    this.intent.until = Date.now() + 2000;
    this.check();
  }
  visibleReply() {
    const intent = this.intent;
    if (!intent || document.visibilityState !== 'visible' || !document.hasFocus()
      || Date.now() > intent.until || !intent.scroller.isConnected
      || this.activeThread() !== intent.threadId || !this.activity.unread.has(intent.threadId)
      || this.activity.completedReplies.get(intent.threadId) !== intent.completion) return null;
    const markers = [...intent.scroller.querySelectorAll('[data-vcl-reply-thread]')]
      .filter((node) => node.dataset.vclReplyThread === intent.threadId);
    const latest = markers.at(-1);
    if (!latest || latest.dataset.vclReplyItem !== intent.completion.itemId
      || latest.dataset.vclReplyCompleted !== 'true') return null;
    const viewport = intent.scroller.getBoundingClientRect();
    let bottom = Math.min(window.innerHeight, viewport.bottom);
    // The native composer can overlay the lower part of the scroll viewport.
    for (const footer of intent.scroller.querySelectorAll('[data-thread-scroll-footer]')) {
      const rect = footer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) bottom = Math.min(bottom, rect.top);
    }
    const top = Math.max(0, viewport.top);
    const left = Math.max(0, viewport.left), right = Math.min(window.innerWidth, viewport.right);
    const bodies = latest.querySelectorAll('[data-markdown-text-style="assistant-message"]');
    for (const body of bodies) {
      if (!body.textContent.trim() || body.closest('[hidden], [inert], [aria-hidden="true"]')) continue;
      const rect = body.getBoundingClientRect();
      const visibleHeight = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
      const visibleWidth = Math.min(right, rect.right) - Math.max(left, rect.left);
      if (rect.height > 0 && rect.width > 0 && visibleHeight >= Math.min(24, rect.height)
        && visibleWidth >= Math.min(24, rect.width)) return latest;
    }
    return null;
  }
  check() {
    const reply = this.visibleReply();
    if (!reply) { clearTimeout(this.timer); this.timer = null; return; }
    if (this.timer) return;
    const intent = this.intent;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.intent === intent && this.visibleReply() === reply
        && this.activity.acknowledgeReply(intent.threadId, intent.completion)) {
        this.reset(); this.onRead();
      }
    }, 300);
  }
  reset() {
    clearTimeout(this.timer); this.timer = null;
    this.observer?.disconnect(); this.observer = null; this.intent = null;
  }
  dispose() { this.reset(); this.abort.abort(); }
}
