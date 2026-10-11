import assert from 'node:assert/strict';
import vm from 'node:vm';

// Extract the actual target build's reset function, without starting the app.
export function checkNativeDraftLifecycle(source) {
  const id = '[A-Za-z_$][\\w$]*';
  const matches = [...source.matchAll(new RegExp(`function (${id})\\((${id}),\\{clientNewThreadId:(${id}),draftThreadLocationId:(${id})\\}\\)\\{`, 'g'))];
  assert.equal(matches.length, 1);
  const [match] = matches;
  const end = /}function |}var /.exec(source.slice(match.index));
  assert.ok(end);
  const native = source.slice(match.index, match.index + end.index + 1);
  const [, name, scopeName, client, slot] = match;
  const atom = new RegExp(`if\\(${scopeName}\\.get\\((${id}),${slot}\\)!==${client}\\)return;`).exec(native)?.[1];
  const generator = new RegExp(`let (${id})=(${id})\\(\\);(${id})\\(${scopeName},${slot},\\1\\),`).exec(native);
  const injected = /if\(typeof [\s\S]+?\.vclDraftKey;/.exec(native)?.[0];
  assert.ok(atom && generator && injected, '项目草稿重置结构不完整');
  for (const entry of ['/', '/extension/panel/new']) {
    for (const broken of [true, false]) {
      const draftAtom = Symbol('draft');
      const drafts = new Map();
      const aliases = new Map();
      const conversations = new Map();
      let sequence = 0;
      const generate = () => `client-${++sequence}`;
      const context = vm.createContext({ [atom]: draftAtom, [generator[2]]: generate, [generator[3]]() {} });
      vm.runInContext(broken ? native.replace(injected, '') : native, context);
      const project = `vscodex-layer-new:${entry}:project`;
      const ordinary = entry === '/' ? 'new-conversation' : 'panel-new-conversation';
      const scope = { value: { kind: 'new', vclDraftKey: project },
        get(target, key) { assert.equal(target, draftAtom); if (!drafts.has(key)) drafts.set(key, generate()); return drafts.get(key); },
        set(target, key, value) { assert.equal(target, draftAtom); drafts.set(key, value); } };
      const ordinaryClient = scope.get(draftAtom, ordinary);
      const otherClient = scope.get(draftAtom, `${project}-other`);
      const clients = [];
      for (const conversation of ['chat-A', 'chat-B', 'chat-C']) {
        const identity = scope.get(draftAtom, project); clients.push(identity);
        aliases.set(conversation, identity); conversations.set(identity, conversation);
        context[name](scope, { clientNewThreadId: identity, draftThreadLocationId: ordinary });
      }
      assert.deepEqual([...aliases.values()].map((identity) => conversations.get(identity)),
        broken ? ['chat-C', 'chat-C', 'chat-C'] : ['chat-A', 'chat-B', 'chat-C']);
      assert.equal(scope.get(draftAtom, ordinary), ordinaryClient);
      assert.equal(scope.get(draftAtom, `${project}-other`), otherClient);
      if (!broken) {
        const fresh = scope.get(draftAtom, project);
        context[name](scope, { clientNewThreadId: clients[0], draftThreadLocationId: ordinary });
        assert.equal(scope.get(draftAtom, project), fresh, '旧回调不能重置新草稿');
        scope.value = { kind: 'local' };
        context[name](scope, { clientNewThreadId: ordinaryClient, draftThreadLocationId: ordinary });
        assert.notEqual(scope.get(draftAtom, ordinary), ordinaryClient);
      }
    }
  }
}
