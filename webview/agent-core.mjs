const labels = { running: '运行中', pendingInit: '启动中', completed: '已完成', interrupted: '已中断',
  shutdown: '已关闭', errored: '失败', notFound: '不可用', unknown: '状态未知',
  waitingOnApproval: '等待审批', waitingOnUserInput: '等待输入' };

export class AgentCatalog {
  constructor() { this.threads = new Map(); this.liveThreads = new Map(); this.turns = new Map(); this.liveActions = new Map(); this.runtime = new Map(); this.revision = 0; }
  page(threads) {
    for (const thread of threads) this.threads.set(thread.id, { ...thread, ...this.liveThreads.get(thread.id) });
  }
  history(threadId, turns) {
    const live = this.turns.get(threadId) ?? new Map(), merged = new Map();
    for (const turn of turns) {
      const actions = new Map(turn.actions.map((action) => [action.id, action]));
      for (const action of live.get(turn.id)?.values() ?? []) if (this.liveActions.has(`${threadId}:${turn.id}:${action.id}`)) actions.set(action.id, action);
      merged.set(turn.id, actions);
    }
    for (const [id, actions] of live) if (!merged.has(id)) merged.set(id, actions);
    this.turns.set(threadId, merged);
  }
  receive(event) {
    if (event?.type === 'agent-discovered') {
      const thread = event.thread; this.liveThreads.set(thread.id, thread);
      this.threads.set(thread.id, { ...this.threads.get(thread.id), ...thread }); return true;
    }
    if (event?.type === 'agent-action') {
      let turns = this.turns.get(event.threadId); if (!turns) this.turns.set(event.threadId, turns = new Map());
      let actions = turns.get(event.turnId); if (!actions) turns.set(event.turnId, actions = new Map());
      actions.set(event.action.id, event.action);
      const revision = this.runtime.get(event.threadId)?.seen.includes(event.turnId) ? 0 : ++this.revision;
      this.liveActions.set(`${event.threadId}:${event.turnId}:${event.action.id}`, revision); return true;
    }
    if (event?.type === 'agent-state') {
      const previous = this.runtime.get(event.threadId);
      if (previous?.seen.includes(event.turnId) || previous?.turnId === event.turnId
        && previous.status !== 'running' && event.status === 'running') return false;
      const seen = previous && previous.turnId !== event.turnId ? [...previous.seen, previous.turnId].slice(-32) : previous?.seen ?? [];
      this.runtime.set(event.threadId, { turnId: event.turnId, status: event.status, seen, revision: ++this.revision }); return true;
    }
    if (event?.type === 'thread-activity' && event.phase === 'status') {
      const thread = this.threads.get(event.threadId);
      const update = { status: event.status, activeFlags: event.activeFlags, runtimeRevision: ++this.revision };
      this.liveThreads.set(event.threadId, { ...this.liveThreads.get(event.threadId), ...update });
      if (thread) { Object.assign(thread, update); return true; }
    }
    return false;
  }
  rows(rootId, scope = 'all') {
    const threads = new Map([...this.threads].map(([id, value]) => [id, { ...value }]));
    const currentTurn = this.runtime.get(rootId)?.turnId ?? [...(this.turns.get(rootId)?.keys() ?? [])].at(-1);
    const involved = new Set();
    for (const [sender, turns] of this.turns) for (const [turnId, actions] of turns) for (const action of actions.values()) {
      for (const id of action.receiverThreadIds) {
        if (id === sender || action.failed && action.tool === 'spawnAgent') continue;
        const thread = threads.get(id) ?? { id, title: action.nickname ?? '子 Agent', parentThreadId: null, status: 'notLoaded' };
        if (action.tool === 'spawnAgent' && thread.parentThreadId == null) thread.parentThreadId = sender;
        // A known different parent must never be overwritten by an action.
        if (action.tool === 'spawnAgent') {
          thread.task = action.prompt ?? thread.task; thread.model = action.model ?? thread.model;
          thread.reasoningEffort = action.reasoningEffort ?? thread.reasoningEffort;
        }
        const revision = this.liveActions.get(`${sender}:${turnId}:${action.id}`) ?? 0;
        if (action.states[id] && revision >= (thread.taskRevision ?? 0)) {
          thread.taskStatus = action.states[id]; thread.taskRevision = revision;
        }
        threads.set(id, thread);
        if (sender === rootId && turnId === currentTurn) involved.add(id);
      }
    }
    const rows = [], seen = new Set([rootId]);
    const visit = (parentId, depth, inTurn) => {
      const children = [...threads.values()].filter((thread) => thread.parentThreadId === parentId)
        .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0) || a.id.localeCompare(b.id));
      for (const thread of children) {
        if (seen.has(thread.id)) continue; seen.add(thread.id);
        const current = inTurn || involved.has(thread.id);
        const runtime = this.runtime.get(thread.id);
        const taskRevision = thread.taskRevision ?? 0, runtimeRevision = runtime?.revision ?? -1;
        let status = runtimeRevision >= taskRevision ? runtime.status : thread.taskStatus ?? runtime?.status ?? 'unknown';
        if ((thread.runtimeRevision ?? 0) >= Math.max(taskRevision, runtimeRevision)) {
          if (thread.status === 'active') status = thread.activeFlags?.find((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') ?? 'running';
          else if (thread.status === 'systemError') status = 'errored';
        }
        if (scope === 'all' || current) rows.push({ ...thread, depth, current, taskStatus: status, statusLabel: labels[status] ?? labels.unknown,
          name: thread.nickname || thread.title || thread.id });
        visit(thread.id, depth + 1, current);
      }
    };
    visit(rootId, 0, false); return rows;
  }
}
