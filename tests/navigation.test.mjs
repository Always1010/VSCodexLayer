import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath, groupThreads, routeThreadId, loadAllThreads } from '../webview/core.mjs';

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
  assert.deepEqual(all.filter((group) => group.current).map((group) => group.key), ['d:/wrk/project', 'd:/empty']);
  assert.equal(all.at(-1).name, '未分类');
  const current = groupThreads(threads, folders, { mode: 'current' });
  assert.equal(current.length, 2);
  assert.equal(current[1].threads.length, 0);
  assert.equal(groupThreads(threads, [], { mode: 'current' }).length, 0);
});

test('项目搜索显示该项目聊天，聊天搜索只显示命中的条目', () => {
  const threads = [{ id: 'a', title: '修复导航', cwd: 'D:/Project' }, { id: 'b', title: '其他聊天', cwd: 'D:/Project' }];
  assert.equal(groupThreads(threads, [], { query: 'project' })[0].threads.length, 2);
  assert.equal(groupThreads(threads, [], { query: '导航' })[0].threads.length, 1);
  assert.equal(groupThreads(threads, [], { query: '不存在' }).length, 0);
  assert.equal(routeThreadId('/local/thread-id?view=review'), 'thread-id');
  assert.equal(routeThreadId('/settings'), null);
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
