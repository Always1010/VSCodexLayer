import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('官方仅获取一次 API，草稿状态原样透传，路由观察错误不影响官方', async () => {
  let calls = 0;
  let state = { draft: 'unsent message' };
  const messages = [];
  const context = vm.createContext({
    document: { querySelector() { return { content: '/local/initial' }; } }, queueMicrotask,
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
  assert.throws(() => vm.runInContext('acquireVsCodeApi()', context), /already acquired/);
});
