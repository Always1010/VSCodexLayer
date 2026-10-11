import fs from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, projectName, groupThreads, routeThreadId, loadAllThreads, ThreadActivity, navigationEdits, overlayNavigationEdits } from '../webview/core.mjs';
import { LayerClient } from '../webview/client.mjs';

test('目录选择等待用户，其他请求保持超时，关闭面板取消等待', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listener; const messages = [];
  const surface = { location: { origin: 'https://test.local' },
    addEventListener(_event, callback) { listener = callback; }, removeEventListener() {} };
  const client = new LayerClient({ postMessage(message) { messages.push(message); } }, surface);
  const picker = client.request('pick-project-folder');
  const ordinary = assert.rejects(client.request('list'), /超时/);
  t.mock.timers.tick(31000); await ordinary;
  assert.equal(client.pending.size, 1, '不能因默认请求超时打断用户选择目录');
  listener({ origin: surface.location.origin, data: { type: 'vscodex-layer/response', id: messages[0].id, result: { cwd: '/chosen' } } });
  assert.equal((await picker).cwd, '/chosen');
  const abandoned = assert.rejects(client.request('pick-project-folder'), /导航已关闭/);
  client.dispose(); await abandoned; assert.equal(client.pending.size, 0);
});

test('提醒优先于运行，结束提示保留至查看，新轮次清除旧提示', () => {
  const activity = new ThreadActivity();
  const thread = { id: 'current', status: 'idle' };
  assert.equal(activity.indicator(thread), null, '历史空闲线程不能一律视为未读');
  const event = (phase, status, activeFlags = []) => activity.receive({ type: 'thread-activity', threadId: thread.id, phase, status, activeFlags });
  event('started', 'active');
  assert.equal(activity.indicator(thread).kind, 'running');
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    event('status', 'active', [flag]);
    assert.equal(activity.indicator(thread).kind, 'attention');
    activity.acknowledge(thread.id);
    assert.equal(activity.indicator(thread).kind, 'attention', '查看不能消除尚未处理的提醒');
  }
  event('status', 'active');
  assert.equal(activity.indicator(thread).kind, 'running');
  event('completed', 'idle');
  assert.equal(activity.indicator({ ...thread, status: 'active' }).kind, 'attention', '旧分页结果不能覆盖实时结束状态');
  event('status', 'notLoaded');
  assert.equal(activity.indicator(thread).kind, 'attention', '状态刷新不能消除结束提示');
  const restored = new ThreadActivity([...activity.unread]);
  assert.equal(restored.indicator(thread).kind, 'attention');
  assert.equal(restored.acknowledge(thread.id), true);
  assert.equal(restored.indicator(thread), null);
  event('started', 'active');
  assert.equal(activity.unread.size, 0);
  event('completed', 'systemError');
  assert.equal(activity.indicator(thread).label, '运行出错，需要查看');
});

test('阅读回执绑定完成轮次，旧回执不能清除新提醒及审批或错误', () => {
  const activity = new ThreadActivity();
  const event = (phase, status = 'idle', activeFlags = []) => activity.receive({
    type: 'thread-activity', threadId: 'current', phase, status, activeFlags, replyItemId: 'reply',
  });
  event('completed');
  const previous = activity.completedReplies.get('current');
  event('started', 'active');
  event('completed');
  assert.equal(activity.acknowledgeReply('current', previous), false);
  assert.equal(activity.unread.has('current'), true);
  const current = activity.completedReplies.get('current');
  for (const flag of ['waitingOnApproval', 'waitingOnUserInput']) {
    event('status', 'active', [flag]);
    assert.equal(activity.acknowledgeReply('current', current), false);
  }
  event('status', 'systemError');
  assert.equal(activity.acknowledgeReply('current', current), false);
  event('status');
  assert.equal(activity.acknowledgeReply('current', current), true);
  assert.equal(activity.unread.has('current'), false);
});

test('Windows 路径规范化、同名项目和多根当前项目正确区分', () => {
  assert.equal(normalizePath('D:\\WRK\\Project\\'), normalizePath('file:///d:/WRK/Project'));
  assert.equal(normalizePath('\\\\?\\UNC\\Server\\Share\\'), '//server/share');
  const threads = [
    { id: 'a', title: '第一条', cwd: 'd:/wrk/project', updatedAt: 2 },
    { id: 'b', title: '第二条', cwd: 'D:\\other\\Project', updatedAt: 3 },
    { id: 'c', title: '无目录', cwd: null, updatedAt: 4 },
  ];
  const folders = [{ name: 'Project', path: 'D:\\WRK\\Project\\' }, { name: 'Empty', path: 'D:/empty' }];
  const all = groupThreads(threads, folders);
  assert.equal(all.length, 4);
  assert.deepEqual(all.filter((group) => group.current).map((group) => group.key), ['d:/empty', 'd:/wrk/project']);
  assert.equal(all.at(-1).name, '未分类');
  const current = groupThreads(threads, folders, { mode: 'current' });
  assert.equal(current.length, 2);
  assert.equal(current.find((group) => group.path === 'D:/empty').threads.length, 0);
  assert.equal(groupThreads(threads, [], { mode: 'current' }).length, 0);
});

test('Linux SSH 项目保持大小写和反斜线，当前项目只匹配完整路径', () => {
  const paths = ['/home/ubuntu/Project', '/home/ubuntu/project', '/home/ubuntu/a\\b', '/home/ubuntu/a/b', '/home/ubuntu/Project '];
  const threads = paths.map((cwd, index) => ({ id: String(index), title: '聊天', cwd }));
  assert.equal(groupThreads(threads).length, 5);
  assert.equal(projectName(paths[2]), 'a\\b');
  assert.equal(normalizePath('file:///home/ubuntu/Project'), paths[0]);
  const current = groupThreads(threads, [{ name: 'Project', path: `${paths[0]}/` }], { mode: 'current' });
  assert.equal(current.length, 1);
  assert.deepEqual(current[0].threads.map(({ id }) => id), ['0']);
});

test('项目搜索显示该项目聊天，聊天搜索只显示命中的条目', () => {
  const threads = [{ id: 'a', title: '修复导航', cwd: 'D:/Project' }, { id: 'b', title: '其他聊天', cwd: 'D:/Project' }];
  assert.equal(groupThreads(threads, [], { query: 'project' })[0].threads.length, 2);
  assert.equal(groupThreads(threads, [], { query: '导航' })[0].threads.length, 1);
  assert.equal(groupThreads(threads, [], { query: '不存在' }).length, 0);
  assert.equal(routeThreadId('/local/thread-id?view=review'), 'thread-id');
  assert.equal(routeThreadId('/settings'), null);
});

test('项目置顶顺序稳定，空项目保留并遵循当前筛选和搜索', () => {
  const threads = [
    { id: 'current', title: '当前聊天', cwd: '/work/Project', updatedAt: 100 },
    { id: 'other', title: '其他聊天', cwd: '/other/Project', updatedAt: 2 },
    { id: 'loose', title: '无目录', cwd: null, updatedAt: 200 },
  ];
  const folders = [{ name: 'Project', path: '/work/Project' }];
  const pinnedProjects = [{ path: '/other/Project', name: 'Project' }, { path: '/empty', name: 'Empty' }];
  const groups = groupThreads(threads, folders, { pinnedProjects });
  assert.deepEqual(groups.map((group) => group.path), ['/other/Project', '/empty', '/work/Project', null]);
  assert.equal(groups[1].total, 0);
  assert.deepEqual(groupThreads([], folders, { pinnedProjects }).map((group) => group.path),
    ['/other/Project', '/empty', '/work/Project'], '所有聊天归档后仍保留置顶目录');
  assert.deepEqual(groupThreads(threads, folders, { pinnedProjects, mode: 'current' }).map((group) => group.path), ['/work/Project']);
  assert.deepEqual(groupThreads(threads, folders, { pinnedProjects, query: '当前聊天' }).map((group) => group.path), ['/work/Project']);
  assert.equal(groupThreads(threads, folders, { pinnedProjects, query: 'empty' })[0].total, 0);
  assert.equal(groupThreads(threads, folders)[0].path, '/work/Project', '取消置顶恢复原排序');
  assert.equal(groupThreads([], [], { pinnedProjects: [{ path: 'D:/Project', name: 'First' },
    { path: 'd:\\Project\\', name: 'Duplicate' }] }).length, 1, 'Windows 同目录不得重复置顶');
});

test('归档视图只显示有记录的项目，按更新时间排序并支持目录和标题搜索', () => {
  const threads = [
    { id: 'old', title: '旧聊天', cwd: '/a/Project', createdAt: 1, updatedAt: 10 },
    { id: 'new', title: '新聊天', cwd: '/a/Project', createdAt: 2, updatedAt: 20 },
    { id: 'other', title: '其他聊天', cwd: '/b/Project', updatedAt: 30 },
  ];
  const folders = [{ path: '/a/Project' }, { path: '/empty' }];
  const options = { archived: true };
  const groups = groupThreads(threads, folders, options);
  assert.deepEqual(groups.map((group) => group.path), ['/a/Project', '/b/Project']);
  assert.deepEqual(groups[0].threads.map((thread) => thread.id), ['new', 'old']);
  assert.equal(groupThreads(threads, folders, { ...options, mode: 'current' }).length, 1);
  assert.equal(groupThreads(threads, folders, { ...options, query: '/b/Project' })[0].threads[0].id, 'other');
  assert.equal(groupThreads(threads, folders, { ...options, query: '新聊天' })[0].threads[0].id, 'new');
  assert.equal(groupThreads([], folders, options).length, 0);
});

test('手动项目合并历史、工作区和置顶，移除登记只影响无其他来源的空项目', () => {
  const threads = [{ id: 'a', title: '历史', cwd: '/a/Project', createdAt: 1 }];
  const folders = [{ name: 'Current', path: '/current' }];
  const registeredProjects = [{ path: '/a/Project' }, { path: '/b/Project' }, { path: '/empty' }, { path: '/current' }, { path: '/empty/' }];
  const pinnedProjects = [{ path: '/empty', name: 'Empty' }];
  const groups = groupThreads(threads, folders, { registeredProjects, pinnedProjects });
  assert.equal(groups.length, 4); assert.ok(groups.every((group) => group.registered));
  assert.equal(groups.find((group) => group.path === '/a/Project').total, 1);
  assert.equal(groups.find((group) => group.path === '/b/Project').total, 0);
  assert.deepEqual(groupThreads(threads, folders, { registeredProjects, mode: 'current' }).map((group) => group.path), ['/current']);
  assert.deepEqual(groupThreads(threads, folders, { registeredProjects, query: '/b/Project' }).map((group) => group.path), ['/b/Project']);
  assert.deepEqual(groupThreads(threads, folders, { pinnedProjects }).map((group) => group.path), ['/empty', '/current', '/a/Project']);
  assert.ok(groupThreads(threads, folders, { pinnedProjects }).every((group) => !group.registered));
});

test('聊天按创建时间固定，活动、标题、分页顺序和搜索不改变位置', () => {
  const threads = [
    { id: 'c', title: '聊天 C', cwd: '/b/Project', createdAt: 30, updatedAt: 30 },
    { id: 'a', title: '聊天 A', cwd: '/b/Project', createdAt: 10, updatedAt: 100 },
    { id: 'b', title: '聊天 B', cwd: '/b/Project', createdAt: 20, updatedAt: 20 },
    { id: 'other', title: '其他', cwd: '/a/Project', createdAt: 1, updatedAt: 1 },
  ];
  const ids = (values, options) => groupThreads(values, [], options).find((group) => group.path === '/b/Project').threads.map((thread) => thread.id);
  assert.deepEqual(ids(threads), ['a', 'b', 'c']);
  const changed = threads.map((thread) => thread.id === 'b' ? { ...thread, updatedAt: 9999, status: 'active', title: '聊天 B 改名' } : thread).reverse();
  assert.deepEqual(ids(changed), ['a', 'b', 'c']);
  assert.deepEqual(ids(changed, { query: '聊天' }), ['a', 'b', 'c']);
  assert.deepEqual(ids([...changed, { id: 'd', title: '新增', cwd: '/b/Project', createdAt: 40 }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(ids(changed.filter((thread) => thread.id !== 'b')), ['a', 'c']);
  assert.deepEqual(groupThreads(changed).map((group) => group.path), ['/a/Project', '/b/Project'], '同名项目按路径固定，不随活动移动');
  const uncertain = [
    { id: 'z', createdAt: 0, updatedAt: 999 }, { id: 'y', createdAt: NaN },
    { id: 'x', createdAt: Infinity }, { id: 'b', createdAt: 5 }, { id: 'a', createdAt: 5 },
  ].map((thread) => ({ ...thread, cwd: '/b/Project', title: thread.id }));
  assert.deepEqual(ids(uncertain), ['a', 'b', 'x', 'y', 'z']);
  assert.deepEqual(ids(uncertain.reverse()), ['a', 'b', 'x', 'y', 'z']);
});

test('读取全部分页并去重，拒绝循环游标和中途取消', async () => {
  const calls = [];
  const result = await loadAllThreads(async (cursor) => {
    calls.push(cursor);
    return cursor === null ? { data: [{ id: 'a', updatedAt: 2 }], nextCursor: 'more' }
      : { data: [{ id: 'a', updatedAt: 1 }, { id: 'b' }], nextCursor: null };
  });
  assert.deepEqual(calls, [null, 'more']);
  assert.equal(result.length, 2);
  assert.equal(result[0].updatedAt, 2);
  await assert.rejects(loadAllThreads(async () => ({ data: [], nextCursor: 'repeated' })), /游标异常/);
  const controller = new AbortController();
  await assert.rejects(loadAllThreads(async () => {
    controller.abort(); return { data: [], nextCursor: null };
  }, { signal: controller.signal }), { name: 'AbortError' });
});

async function navigationFixture(client, timers = { setTimeout, clearTimeout }) {
  const source = await fs.readFile(new URL('../webview/layer.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ ...timers, structuredClone, ThreadActivity, navigationEdits,
    overlayNavigationEdits, AbortController, loadAllThreads, groupThreads, normalizePath, routeThreadId,
    URL, document: { activeElement: null, querySelector: () => null },
  });
  vm.runInContext(source.slice(source.indexOf('const SVG'), source.indexOf('const bridge = globalThis'))
    + '\nglobalThis.Navigation=Navigation;function showLauncher(){}', context);
  const state = { revision: 0, mode: 'all', width: 250, collapsed: null, disabled: false,
    groups: [], pinnedProjects: [], unread: [], unreadTurns: {} };
  const nav = new context.Navigation(client, {}, { state, folders: [] });
  nav.render = () => {}; nav.layout = () => {};
  return nav;
}

test('前端只提交具体操作，广播保留待提交修改，失败重试及旧轮次保护', async () => {
  let remote = { revision: 0, mode: 'all', width: 250, groups: [], pinnedProjects: [], unread: [], unreadTurns: {} };
  let fail = true;
  const requests = [];
  const nav = await navigationFixture({ async request(method, params) {
    requests.push(params); assert.equal(method, 'save-state');
    if (fail) throw new Error('保存失败');
    remote = { ...overlayNavigationEdits(remote, params.operations), revision: remote.revision + 1 };
    return { state: remote };
  } }, { setTimeout: () => 1, clearTimeout() {} });
  nav.state.width = 310; nav.persist();
  const incoming = { ...remote, revision: 1, pinnedProjects: [{ path: '/other', name: 'Other' }] };
  remote = incoming; nav.applyState(incoming);
  assert.equal(nav.state.width, 310); assert.equal(nav.state.pinnedProjects[0].path, '/other');
  await assert.rejects(nav.flushState(), /保存失败/);
  fail = false; await nav.flushState();
  assert.equal(remote.width, 310); assert.equal(remote.pinnedProjects[0].path, '/other');
  assert.deepEqual(JSON.parse(JSON.stringify(requests.at(-1).operations)), [{ type: 'set', key: 'width', value: 310 }]);
  nav.applyState({ ...remote, revision: 0, width: 180 });
  assert.equal(nav.state.width, 310, '迟到状态不能覆盖新版本');
  remote = { ...remote, revision: remote.revision + 1, unread: ['thread'], unreadTurns: { thread: 'new-turn' } };
  nav.queueEdits([{ type: 'acknowledge', threadId: 'thread', turnToken: 'old-turn' }]);
  nav.applyState(remote);
  assert.ok(nav.activity.unread.has('thread'), '旧轮次待提交回执不能隐藏新提醒');
  await nav.flushState(); assert.ok(remote.unread.includes('thread'));
});

test('停用取消延迟保存，等待已有写入，重复点击及失败重试不丢状态', async () => {
  let remote = { revision: 0, mode: 'all', width: 250, groups: [], pinnedProjects: [], unread: [] };
  const calls = []; let release; let fail = false; let timer;
  const nav = await navigationFixture({ async request(_method, params) {
    calls.push(params.operations);
    if (calls.length === 1) await new Promise((resolve) => { release = resolve; });
    if (fail) throw new Error('保存失败');
    remote = { ...overlayNavigationEdits(remote, params.operations), revision: remote.revision + 1 };
    return { state: remote };
  } }, { setTimeout(callback) { timer = callback; return 1; }, clearTimeout() { timer = null; } });
  nav.dispose = () => { nav.disposed = true; }; nav.showError = () => {};
  nav.state.width = 310; nav.persist();
  const saving = nav.flushState();
  const disabling = nav.disable();
  await nav.disable();
  assert.equal(timer, null); assert.equal(calls.length, 1);
  nav.state.width = 320; nav.persist();
  release(); await saving; await disabling;
  assert.equal(calls.length, 2); assert.equal(remote.width, 310); assert.equal(remote.disabled, true);
  assert.equal(nav.disposed, true);
  nav.queueEdits([{ type: 'set', key: 'disabled', value: false }]);
  assert.equal(calls.length, 2, '销毁后不再保存');

  const retry = await navigationFixture({ async request(_method, params) {
    if (fail) throw new Error('保存失败');
    remote = { ...overlayNavigationEdits(remote, params.operations), revision: remote.revision + 1 };
    return { state: remote };
  } }, { setTimeout: () => 1, clearTimeout() {} });
  retry.dispose = () => { retry.disposed = true; }; retry.showError = () => {};
  retry.state.width = 330; retry.persist(); fail = true;
  await retry.disable();
  assert.equal(retry.disposed, false); assert.equal(retry.disabling, false);
  assert.ok(retry.pendingEdits.length, '失败保留待提交修改');
  fail = false; await retry.disable();
  assert.equal(remote.width, 330); assert.equal(remote.disabled, true); assert.equal(retry.disposed, true);
});

test('分页期间通知不丢弃有效结果，归档恢复过滤迟到条目且刷新合并', async () => {
  const requests = []; const timers = new Map(); let timerId = 0;
  const nav = await navigationFixture({ request(method, params) {
    assert.equal(method, 'list');
    return new Promise(resolve => requests.push({ params, resolve }));
  } }, { setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } });
  nav.status = { classList: { remove() {} } }; nav.showError = () => {};
  const reading = nav.refresh('active');
  nav.invalidateLists(); nav.invalidateLists();
  requests[0].resolve({ data: [{ id: 'keep' }, { id: 'archived' }], nextCursor: 'page-2' });
  await new Promise(resolve => setImmediate(resolve));
  nav.invalidateLists({ method: 'thread/archived', threadId: 'archived' });
  requests[1].resolve({ data: [{ id: 'later' }], nextCursor: null });
  await reading;
  assert.deepEqual(nav.threads.map(thread => thread.id), ['keep', 'later']);
  assert.equal(nav.hasLoaded, true); assert.equal(timers.size, 1, '多次通知仅安排一次后续读取');
  nav.invalidateLists(); nav.invalidateLists();
  assert.equal(timers.size, 1, '持续通知不能推迟已安排的刷新');
  const errorRefresh = nav.refresh('active');
  requests[2].resolve({ error: true }); await errorRefresh;
  assert.deepEqual(nav.threads.map(thread => thread.id), ['keep', 'later']);
  assert.equal(timers.size, 0, '无新通知的失败不自动循环重试');
  nav.view = 'archived';
  const archivedReading = nav.refresh('archived');
  nav.invalidateLists({ method: 'thread/unarchived', threadId: 'restored' });
  requests[3].resolve({ data: [{ id: 'restored' }, { id: 'still-archived' }], nextCursor: null });
  await archivedReading;
  assert.deepEqual(nav.archiveView.threads.map(thread => thread.id), ['still-archived']);
  assert.deepEqual(nav.threads.map(thread => thread.id), ['keep', 'later'], '归档响应不能覆盖普通视图');
});
