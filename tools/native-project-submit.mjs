import assert from 'node:assert/strict';
import vm from 'node:vm';

const id = '[A-Za-z_$][\\w$]*';
function functionSource(source, name) {
  let start = source.indexOf(`function ${name}(`);
  if (source.slice(start - 6, start) === 'async ') start -= 6;
  const tail = /}(?:async )?function |}var /.exec(source.slice(start));
  assert.ok(start >= 0 && tail, `无法提取官方函数：${name}`);
  return source.slice(start, start + tail.index + 1);
}
function capture(source, pattern) {
  const matches = [...source.matchAll(new RegExp(pattern, 'g'))];
  const names = new Set(matches.map((match) => match[1]));
  assert.equal(names.size, 1, `官方提交依赖不唯一：${pattern}`);
  return [...names][0];
}

// Execute the native composer and its real membership callback without a server,
// then apply the native first-turn workspace decision to the resulting state.
export async function checkProjectSubmit(composer, runtime, expectedFirstTurnError = /fixture-first-turn-ready/) {
  const marker = composer.indexOf('startConversationWithPrimaryRuntimeForFirstTurn:');
  const entryStart = composer.lastIndexOf('function ', marker);
  const entryName = /^function ([\w$]+)\(/.exec(composer.slice(entryStart))?.[1];
  assert.ok(entryName);
  const entry = functionSource(composer, entryName);
  const signature = entry.slice(0, entry.indexOf('}){'));
  const scope = capture(signature, `scope:(${id}),`);
  const client = capture(signature, `clientThreadId:(${id}),`);
  const context = capture(entry, `prepareFirstTurn:(${id})\\.worktreePrompt`);
  const params = entry.includes('projectAssignment:undefined')
    ? capture(entry, `\\.\\.\\.(${id}),projectAssignment:undefined`)
    : capture(entry, `baseParams:(${id}),prepareFirstTurn:`);
  const bindings = { DOMException, globalThis: { __vscodexLayerBridge: {
    async validateProject(cwd) { if (cwd === '/missing') throw new Error('目录已删除'); return { cwd }; },
  } } };
  const bind = (pattern, value) => { bindings[capture(entry, pattern)] = value; };
  for (const match of entry.matchAll(new RegExp(`\\.(?:get|set)\\((${id})`, 'g'))) bindings[match[1]] = Symbol(match[1]);
  for (const match of entry.matchAll(new RegExp(`instanceof (${id})`, 'g'))) {
    if (match[1] !== 'Error') bindings[match[1]] = class extends Error {};
  }
  bind(`let ${id}=${id}\\?${id}:(${id});`, () => '/local/test');
  bind(`=(${id})\\(${scope},${client}\\),${id}=${id}\\(${context}\\),`, () => async () => false);
  bind(`=(${id})\\(${context}\\),${id},${id},${id},`, (context) => context.prompt);
  bind(`restoreMessage=(${id})\\(`, ({ context, cwd }) => ({ context, cwd }));
  bind(`\\(0,(${id})\\.default\\)\\(async`, { default: (fn) => fn });
  bind(`(${id})\\.error\\(\x60Error creating local task`, { error() {}, warning() {} });
  bind(`=(${id})\\(\\[\\.\\.\\.${params}\\.attachments`, (items) => items);
  bind(`\\?\\[\\]:(${id})\\(${id}\\.imageAttachments\\)`, () => []);
  bind(`(${id})\\(${id},${context}\\.aeonStartTarget\\)`, () => null);
  bind(`await (${id})\\(\\{scope:${scope},context:`, async (options) => ({ ...options,
    fileAttachments: [], addedFiles: [], input: [{ type: 'text', text: options.prompt }], config: {} }));
  bind(`Promise\\.all\\(\\[${id},(${id})\\(\\{scope:`, async () => ({}));
  bind(`let ${id}=(${id})\\(${scope},${client}\\)`, () => () => {});
  bind(`==null\\?(${id})\\(${scope},${client},`, () => () => {});
  bind(`(${id})\\(${scope},${id}\\.workHomePolicyAcceptance\\)`, () => {});
  bind(`(${id})\\(${scope},${id}\\.openingPromptForHistory\\)`, () => undefined);
  bind(`cloudThreadPrototype===!0\\|\\|(${id})\\(`, (roots) => roots.every((root) => root === '~'));
  bind(`let ${id}=(${id})\\(${id},${id}\\),${id}=${id}\\.localProjectId`,
    (context, target) => target?.workspaceRoots ?? context.workspaceRoots ?? ['~']);
  bind(`,${id}=(${id})\\(${id},${id},${id}\\),\\{context:`,
    (_context, hostId) => ({ threadCreationHostId: hostId }));
  bind(`let ${id}=(${id})\\(${context}\\.localProjectId,${id}\\.projectAssignment\\)`,
    (projectId, assignment) => projectId == null ? assignment : { projectKind: 'local', projectId });
  bind(`workspaceRoots:${id}\\}\\):(${id})\\(\\{hostId:`, () => { throw new Error('意外回退到目录分配'); });
  const paramsHelper = capture(entry, `,${params}=(${id})\\(\\{`);
  const membershipStart = composer.indexOf('saveThreadProjectAssignment:async(') + 'saveThreadProjectAssignment:'.length;
  assert.ok(membershipStart >= 'saveThreadProjectAssignment:'.length);
  let depth = 0;
  let membershipEnd;
  let quote;
  for (let cursor = composer.indexOf('=>{', membershipStart) + 2; cursor < composer.length; cursor += 1) {
    const character = composer[cursor];
    if (quote) {
      if (character === '\\') cursor += 1;
      else if (character === quote) quote = undefined;
    } else if (['"', "'", '`'].includes(character)) quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) { membershipEnd = cursor; break; }
  }
  assert.ok(membershipEnd > membershipStart);
  const membership = composer.slice(membershipStart, membershipEnd + 1);
  const membershipConnection = capture(membership, `await (${id})\\.setMembership\\(`);
  const membershipScope = capture(membership, `,(${id})!=null`);
  const decisionName = capture(runtime, `async function (${id})\\(\\{environmentCwd:`);
  const decisions = vm.createContext({});
  vm.runInContext(functionSource(runtime, decisionName), decisions);
  vm.runInContext(`membership=${membership}`, Object.assign(decisions, {
    [membershipScope]: null, [membershipConnection]: { async setMembership(value) {
      decisions.membershipValue = value;
    } },
  }));
  const environment = vm.createContext(bindings);
  // Base-parameter conversion is native too, including permissions and attachments.
  vm.runInContext(functionSource(composer, paramsHelper), environment);
  // Its permission builders are unused when app-server defaults are selected.
  const converter = functionSource(composer, paramsHelper);
  environment[capture(converter, `let ${id}=(${id})\\(\\[`)] = (items) => items;
  environment[capture(converter, `multiAgentMode:(${id}),`)] = 'explicitRequestOnly';
  environment[capture(converter, `\\.filter\\((${id})\\)`)] = () => false;
  vm.runInContext(entry.replaceAll('import.meta.url', '"https://native.test/"'), environment);
  const native = environment[entryName];
  const captured = [];
  for (const cwd of ['/home/ubuntu/Current/Project', '/home/ubuntu/Other/Project', '/home/ubuntu/worktrees/branch']) {
    const submit = native({ scope: { value: { kind: 'new' }, get: () => undefined },
      isMounted: () => true, resolvedHostId: 'local', newConversationNavigation: 'background',
      agentMode: 'auto', shouldSendPermissionOverrides: false,
      async startConversationWithPrimaryRuntimeForFirstTurn({ baseParams }) {
        captured.push(baseParams);
        decisions.membershipValue = undefined;
        // Match the runtime creation contract: only defined assignments are saved.
        if (baseParams.projectAssignment !== undefined) await decisions.membership({ threadId: 'fixture', assignment: baseParams.projectAssignment });
        const state = decisions.membershipValue?.projectless ? { project: null, applied: null } : undefined;
        const projectless = await decisions[decisionName]({ state, workspaceKind: baseParams.workspaceKind,
          isProjectlessConversation: async () => decisions.membershipValue?.projectless === true });
        if (projectless) throw new Error('projectless-thread-cwd not supported in extension');
        assert.equal(baseParams.cwd, cwd);
        assert.deepEqual(Array.from(baseParams.workspaceRoots), [cwd]);
        assert.equal(baseParams.projectAssignment, undefined);
        assert.equal(baseParams.input[0].text, '验证项目首条消息');
        throw new Error('fixture-first-turn-ready');
      } });
    const context = { vclProjectCwd: cwd, prompt: '验证项目首条消息', existingWorkspaceRoot: '/wrong',
      workspaceRoots: ['/wrong'], localProjectId: 'wrong-project', fileAttachments: [], imageAttachments: [], addedFiles: [] };
    await assert.rejects(submit.handleSubmitLocal(context, '/wrong', undefined, { hostId: 'local', workspaceRoots: ['/wrong'] }), expectedFirstTurnError);
    const before = captured.length;
    await assert.rejects(submit.handleSubmitLocal({ ...context, vclProjectCwd: '/missing' }, '/wrong'), /目录已删除/);
    assert.equal(captured.length, before);
  }
  // Preserve the native semantics of a deliberately projectless desktop thread.
  await decisions.membership({ threadId: 'desktop-fixture', assignment: null });
  assert.equal(await decisions[decisionName]({ state: { project: null, applied: null }, workspaceKind: 'project',
    isProjectlessConversation: async () => true }), true);
}
