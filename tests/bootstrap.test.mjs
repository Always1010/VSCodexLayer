import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('官方仅获取一次 API，草稿状态原样透传，路由观察错误不影响官方', async () => {
  let calls = 0;
  let state = { draft: 'unsent message' };
  const messages = [];
  const context = vm.createContext({
    document: { querySelector() { return { content: '/local/initial' }; } }, queueMicrotask, URLSearchParams,
    acquireVsCodeApi() {
      calls += 1;
      if (calls > 1) throw new Error('already acquired');
      return Object.freeze({ postMessage(message) { messages.push(message); },
        getState() { return state; }, setState(value) { state = value; return value; } });
    },
  });
  vm.runInContext(await fs.readFile(new URL('../webview/bootstrap.js', import.meta.url), 'utf8'), context);
  assert.equal(calls, 0);
  const officialApi = vm.runInContext('acquireVsCodeApi()', context);
  assert.equal(officialApi.getState().draft, 'unsent message');
  officialApi.setState({ draft: 'updated' });
  assert.equal(state.draft, 'updated');
  const bridge = context.__vscodexLayerBridge;
  const snapshots = [];
  bridge.subscribe((value) => snapshots.push(value));
  bridge.subscribe(() => { throw new Error('addon error'); });
  officialApi.postMessage({ type: 'ready' });
  bridge.observeRoute('/local/another');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots.at(-1).route, '/local/another');
  assert.equal(snapshots.at(-1).ready, true);
  bridge.postMessage({ type: 'vscodex-layer/request', id: 'one' });
  assert.equal(messages.length, 2);
  assert.equal(calls, 1);
  let resumed = 0;
  assert.equal(bridge.resumeDraft(), false);
  const remove = bridge.setNewChatHandler(() => { resumed += 1; });
  assert.equal(bridge.resumeDraft({ selectChat: true }), true);
  assert.equal(bridge.resumeDraft({ freshDraft: true }), true);
  assert.equal(bridge.resumeDraft({ prefillPrompt: '用户明确预填' }), false);
  assert.equal(bridge.resumeDraft({ activeProject: null }), false);
  assert.equal(bridge.resumeDraft({ prefillComposerDraft: { text: 'rich draft' } }), false);
  assert.equal(resumed, 2);
  assert.equal(state.draft, 'updated');
  remove();
  assert.equal(bridge.resumeDraft(), false);
  const project = bridge.projectRoute('/', '/', '?vclProjectCwd=D%3A%5COther%5CProject');
  assert.equal(project.vclProjectCwd, 'D:\\Other\\Project');
  assert.equal(project.vclDraftKey, bridge.projectRoute('/', '/', '?vclProjectCwd=d%3A%2Fother%2Fproject%2F').vclDraftKey);
  assert.notEqual(project.vclDraftKey, bridge.projectRoute('/', '/', '?vclProjectCwd=D%3A%5CCurrent%5CProject').vclDraftKey);
  assert.notEqual(project.vclDraftKey, bridge.projectRoute('/extension/panel/new', '/', '?vclProjectCwd=D%3A%5COther%5CProject').vclDraftKey);
  const linuxDraft = (cwd, pathname = '/') => bridge.projectRoute(pathname, '/', `?vclProjectCwd=${encodeURIComponent(cwd)}`).vclDraftKey;
  assert.notEqual(linuxDraft('/home/ubuntu/Project'), linuxDraft('/home/ubuntu/project'));
  assert.equal(linuxDraft('/home/ubuntu/Project/'), linuxDraft('/home/ubuntu/Project'));
  assert.notEqual(linuxDraft('/home/ubuntu/a\\b'), linuxDraft('/home/ubuntu/a/b'));
  assert.notEqual(linuxDraft('/'), linuxDraft(''));
  assert.notEqual(linuxDraft('/home/ubuntu/Project'), linuxDraft('/home/ubuntu/Project', '/extension/panel/new'));
  assert.equal(bridge.projectRoute('/local/another', '/', '?vclProjectCwd=D%3A%5COther%5CProject'), null);
  assert.equal(bridge.projectRoute('/', '/', ''), null);
  assert.equal(bridge.projectCwd({ kind: 'local', vclProjectCwd: 'D:\\Other' }), undefined);
  await assert.rejects(bridge.validateProject('D:\\Other'), /尚未就绪/);
  bridge.setProjectValidator(async (cwd) => ({ cwd }));
  assert.equal((await bridge.validateProject('D:\\Other')).cwd, 'D:\\Other');
  assert.throws(() => vm.runInContext('acquireVsCodeApi()', context), /already acquired/);
});
