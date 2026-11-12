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
export async function checkProjectSubmit(composer, runtime, expectedFirstTurnError = /fixture-first-turn-ready/, dependencySources = {}) {
  const entryName = capture(composer,
    `function (${id})\\(\\{scope:${id},[^}]+startConversationWithPrimaryRuntimeForFirstTurn:${id},[^}]+\\}\\)\\{`);
  const entry = functionSource(composer, entryName);
  const split = entry.includes('useAsbDirect:');
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
  bind(split ? `let ${id}=${id}\\?${id}:(${id}),` : `let ${id}=${id}\\?${id}:(${id});`, () => '/local/test');
  const routeTemplate = new RegExp(`,${id}=${id}\\?${id}:(${id}),`).exec(entry);
  if (routeTemplate) bindings[routeTemplate[1]] = '/local/:conversationId';
  bind(`=(${id})\\(${scope},${id}\\),${id}=${id}\\(${context}\\),`, () => async () => false);
  bind(split ? `=(${id})\\(${context}\\),${id},${id},${id}=` : `=(${id})\\(${context}\\),${id},${id},${id},`, (context) => context.prompt);
  bind(`restoreMessage=(${id})\\(`, ({ context, cwd }) => ({ context, cwd }));
  bind(`\\(0,(${id})\\.default\\)\\(async`, { default: (fn) => fn });
  bind(`(${id})\\.error\\(\x60Error creating local task`, { error() {}, warning() {} });
  if (split) bind(`throw!(${id})\\(${id}\\)&&`, () => false);
  bind(`=(${id})\\(\\[\\.\\.\\.${params}\\.attachments`, (items) => items);
  bind(`\\?\\[\\]:(${id})\\(${id}\\.imageAttachments\\)`, () => []);
  if (!split) bind(`(${id})\\(${id},${context}\\.aeonStartTarget\\)`, () => null);
  bind(`await (${id})\\(\\{scope:${scope},context:`, async (options) => ({ ...options,
    fileAttachments: [], addedFiles: [], input: [{ type: 'text', text: options.prompt }], config: {} }));
  if (!split) bind(`Promise\\.all\\(\\[${id},(${id})\\(\\{scope:`, async () => ({}));
  bind(`(?:let |,)${id}=(${id})\\(${scope},${id}\\)`, () => () => {});
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
  const preparation = new RegExp(`let ${id},${id}=(${id})\\(${id}\\);try\\{`).exec(entry);
  if (preparation) bindings[preparation[1]] = () => ({ settle() {}, settleError() {}, prepare: async (context) => context });
  const goalContext = new RegExp(`await ${id}\\((${id})\\(${id}\\),${id}\\.mode`).exec(entry);
  if (goalContext) bindings[goalContext[1]] = (context) => context;
  const creationNotice = new RegExp(`let ${id}=(${id})\\(${scope},${id}\\.threadCreationHostId,${id}(?:,${id}!=null)?\\)`).exec(entry);
  if (creationNotice) bindings[creationNotice[1]] = () => () => {};
  const paramsHelper = capture(entry, `,${params}=(${id})\\(\\{`);
  const membershipSources = [composer, ...Object.values(dependencySources)].filter((source) => source.includes('saveThreadProjectAssignment:async('));
  assert.equal(membershipSources.length, 1, '官方项目归属回调必须唯一');
  const membershipSource = membershipSources[0];
  const membershipStart = membershipSource.indexOf('saveThreadProjectAssignment:async(') + 'saveThreadProjectAssignment:'.length;
  assert.ok(membershipStart >= 'saveThreadProjectAssignment:'.length);
  let depth = 0;
  let membershipEnd;
  let quote;
  for (let cursor = membershipSource.indexOf('=>{', membershipStart) + 2; cursor < membershipSource.length; cursor += 1) {
    const character = membershipSource[cursor];
    if (quote) {
      if (character === '\\') cursor += 1;
      else if (character === quote) quote = undefined;
    } else if (['"', "'", '`'].includes(character)) quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) { membershipEnd = cursor; break; }
  }
  assert.ok(membershipEnd > membershipStart);
  const membership = membershipSource.slice(membershipStart, membershipEnd + 1);
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
  let converterSource = composer;
  let converterName = paramsHelper;
  if (!composer.includes(`function ${paramsHelper}(`)) {
    const imports = [...composer.matchAll(/import\{([^}]+)\}from["']\.\/([^"']+)["']/g)]
      .flatMap((match) => match[1].split(',').map((binding) => ({ file: match[2], parts: binding.trim().split(/\s+as\s+/) })))
      .filter(({ parts }) => parts.at(-1) === paramsHelper);
    assert.equal(imports.length, 1, '官方基础参数转换模块必须唯一');
    const imported = imports[0];
    converterSource = dependencySources[`webview/assets/${imported.file}`];
    assert.equal(typeof converterSource, 'string', `缺少官方基础参数转换模块：${imported.file}`);
    converterName = capture(converterSource, `(?:export\\{|,)(${id}) as ${imported.parts[0]}(?:,|\\})`);
  }
  const converter = functionSource(converterSource, converterName);
  vm.runInContext(converter, environment);
  environment[paramsHelper] = environment[converterName];
  // Its permission builders are unused when app-server defaults are selected.
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
