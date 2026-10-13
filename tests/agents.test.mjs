import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentCatalog } from '../webview/agent-core.mjs';
import { AgentOverview } from '../webview/agent-overview.mjs';

const action = (id, tool, receiverThreadIds, states = {}) => ({ id, tool, receiverThreadIds, states });

test('关联树按编号去重，本轮包含后代，失败创建与无关聊天不计数', () => {
  const catalog = new AgentCatalog();
  catalog.page([{ id: 'a', parentThreadId: 'root', title: 'A', status: 'idle' },
    { id: 'b', parentThreadId: 'a', title: 'B', status: 'notLoaded' },
    { id: 'other', parentThreadId: 'foreign', title: '其他' }]);
  catalog.history('root', [{ id: 'old', actions: [action('spawn', 'spawnAgent', ['a'], { a: 'completed' })] },
    { id: 'current', actions: [action('send', 'sendInput', ['a']), action('wait', 'wait', ['a']),
      { ...action('failed', 'spawnAgent', ['phantom']), failed: true }] }]);
  catalog.history('a', [{ id: 'nested', actions: [action('spawn-b', 'spawnAgent', ['b'])] }]);
  assert.deepEqual(catalog.rows('root').map((row) => [row.id, row.depth]), [['a', 0], ['b', 1]]);
  assert.equal(catalog.rows('root', 'current').length, 2);
  assert.equal(catalog.rows('root')[1].statusLabel, '状态未知', '未加载不能当成完成');
  catalog.receive({ type: 'agent-state', threadId: 'root', turnId: 'new', status: 'running' });
  assert.equal(catalog.rows('root', 'current').length, 0, '新轮次不能包含上一轮调用');
  catalog.receive({ type: 'agent-action', threadId: 'root', turnId: 'new', action: action('resume', 'resumeAgent', ['a']) });
  assert.equal(catalog.rows('root', 'current').length, 2);
});

test('迟到分页和历史不能覆盖实时任务状态，新轮次不会被旧完成复活', () => {
  const catalog = new AgentCatalog();
  catalog.receive({ type: 'agent-discovered', thread: { id: 'a', parentThreadId: 'root', title: '新名称', status: 'active' } });
  catalog.receive({ type: 'agent-action', threadId: 'root', turnId: 'r1', action: action('spawn', 'spawnAgent', ['a'], { a: 'running' }) });
  catalog.receive({ type: 'agent-state', threadId: 'a', turnId: 'a1', status: 'completed' });
  catalog.page([{ id: 'a', parentThreadId: 'root', title: '旧名称', status: 'active' }]);
  catalog.history('root', [{ id: 'r1', actions: [action('spawn', 'spawnAgent', ['a'], { a: 'pendingInit' })] }]);
  assert.equal(catalog.rows('root')[0].statusLabel, '已完成');
  assert.equal(catalog.rows('root')[0].name, '新名称');
  catalog.receive({ type: 'agent-state', threadId: 'a', turnId: 'a2', status: 'running' });
  catalog.receive({ type: 'thread-activity', threadId: 'a', phase: 'status', status: 'active', activeFlags: ['waitingOnApproval'] });
  catalog.receive({ type: 'agent-state', threadId: 'a', turnId: 'a1', status: 'completed' });
  assert.equal(catalog.rows('root')[0].statusLabel, '等待审批');
  catalog.receive({ type: 'agent-state', threadId: 'a', turnId: 'a2', status: 'interrupted' });
  assert.equal(catalog.rows('root')[0].statusLabel, '已中断');
  catalog.receive({ type: 'agent-action', threadId: 'root', turnId: 'r2', action: action('reuse', 'sendInput', ['a'], { a: 'running' }) });
  assert.equal(catalog.rows('root')[0].statusLabel, '运行中', '复用 Agent 的新调用不能被旧轮次终态或审批标记覆盖');
  catalog.receive({ type: 'agent-action', threadId: 'root', turnId: 'r2', action: action('wait-new', 'wait', ['a'], { a: 'completed' }) });
  assert.equal(catalog.rows('root')[0].statusLabel, '已完成', '未订阅子线程时也应采用新的协作任务终态');
});

test('子 Agent 列表读取活动和归档的全部分页，重复游标保留已发现记录并允许重试', async () => {
  const requests = [], catalog = new AgentCatalog(); let broken = true;
  const overview = Object.assign(Object.create(AgentOverview.prototype), { catalog, render() {}, client: {
    async request(method, params) {
      requests.push([method, params]);
      if (params.archived) return { data: [{ id: 'archived', parentThreadId: 'root' }], nextCursor: null };
      return { data: [{ id: params.cursor ? 'second' : 'first', parentThreadId: 'root' }], nextCursor: !params.cursor || broken ? 'page2' : null };
    },
  } });
  await assert.rejects(overview.loadIndex(), /游标重复/);
  assert.equal(catalog.rows('root').length, 2); assert.equal(overview.indexComplete, undefined);
  broken = false; await overview.loadIndex();
  assert.equal(catalog.rows('root').length, 3); assert.equal(overview.indexComplete, true);
  assert.ok(requests.some(([, params]) => params.archived));
});
