import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { probeCompatibility } from '../lib/compatibility.mjs';
import { findInstalledExtension } from '../lib/extension-discovery.mjs';
import { findExtension } from '../tools/layer.mjs';
import { buildReasoningPatchFiles, patchReasoningActivity, patchReasoningRenderer, patchReadTarget } from '../adapters/reasoning.mjs';
import { patchProjectDraftReset } from '../adapters/draft-lifecycle.mjs';
import { checkNativeDraftLifecycle } from '../tools/native-draft-lifecycle.mjs';
import { archiveDependencies, patchMenuHeader, validateHeaderImports, portalDependency } from '../adapters/chat-menu.mjs';
import { buildAgentDetailHeader, patchAgentDetailHeader } from '../adapters/agent-detail.mjs';
import { patchSplitRouteScope, patchSplitComposerScope } from '../adapters/codex-compatible.mjs';

test('缺少原生子聊天组件保留完整聊天入口，标题桥歧义时拒绝转换', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vcl-agent-detail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'webview', 'assets'), { recursive: true });
  const original = 'export{Header as t};';
  const result = await buildAgentDetailHeader(root, original);
  assert.equal(result.header, original); assert.equal(result.compatibility.supported, false);
  const detail = { file: 'webview/assets/thread.js', component: 't', initializer: 's' };
  assert.throws(() => patchAgentDetailHeader(original, detail), /增强聊天标题/);
  assert.throws(() => patchAgentDetailHeader('export{__vclHeader as t};export{__vclHeader as t};', detail), /数量异常/);
});

test('原生归档恢复接入缺失或歧义时拒绝生成补丁', () => {
  const source = 'import{a as scope,b as atom,c as service,d as pins,e as OpenError}from"./native.js";'
    + 'function footer(){let store=scope(atom);await service(store,host).unarchiveConversation(id,{useAppServerPins:store.get(pins)});'
    + 'error instanceof OpenError}export{init as n,footer as t};';
  assert.equal(archiveDependencies(source).service.exported, 'c');
  assert.equal(archiveDependencies(source).initializer, 'n', '导入必须使用公开导出名，不能使用内部函数名');
  const predicate = source.replace('e as OpenError', 'e as isOpenError')
    .replace('error instanceof OpenError', 'done?.(isOpenError(error)?`restored`:null),isOpenError(error)?partial():failed()');
  assert.equal(archiveDependencies(predicate).openErrorKind, 'predicate');
  assert.equal(archiveDependencies(predicate).openError.exported, 'e');
  assert.throws(() => archiveDependencies(source.replace('unarchiveConversation', 'other')), /数量异常：0/);
  assert.throws(() => archiveDependencies(source + source), /数量异常：2/);
});

test('Portal 依赖支持原生调用和独立加载器，仅使用真实导出', () => {
  assert.equal(portalDependency('var dom=interop(loader(),1);dom.createPortal(node,root);export{loader as publicDom};'), 'publicDom');
  const source = 'import{publicLoader as unrelated}from"./other.js";'
    + 'var native=common((exports=>{exports.createPortal=function(node,root){return{node,root}}})),publicLoader=common(((exports,module)=>{module.exports=native()}));'
    + 'export{publicLoader as dom};';
  assert.equal(portalDependency(source), 'dom');
  assert.throws(() => portalDependency('unknown layout'), /数量异常/);
  assert.throws(() => portalDependency(source + source), /数量异常/);
  assert.throws(() => portalDependency(source.replace('publicLoader as dom', 'other as dom')), /数量异常/);
});

test('菜单桥导入核对实际导出，阻止归档模块缺少导出导致聊天页面崩溃', async () => {
  const archiveSource = 'import{B as unrelated}from"./other.js";'
    + 'import{a as scope,b as atom,c as service,d as pins,e as OpenError}from"./native.js";'
    + 'function footer(){let store=scope(atom);await service(store,host).unarchiveConversation(id,{useAppServerPins:store.get(pins)});'
    + 'error instanceof OpenError}export{B as n,footer as t};';
  const options = { menuPath: 'menu.js', menu: { initializer: 'n', componentExport: 't',
    react: { exported: 'react', file: './native.js' }, jsx: { exported: 'jsx', file: './native.js' } },
    dom: { exported: 'dom', file: './native.js' }, archive: { path: 'archive.js', ...archiveDependencies(archiveSource) } };
  const modules = { './menu.js': 'export{init as n,menu as t};', './archive.js': archiveSource,
    './native.js': 'export{scope as a,atom as b,service as c,pins as d,OpenError as e,R as react,J as jsx,D as dom};' };
  const read = async (file) => { assert.ok(file in modules); return modules[file]; };
  const header = patchMenuHeader('function header(){}export{header as t};', options);
  await validateHeaderImports(header, read);
  const broken = patchMenuHeader('function header(){}export{header as t};',
    { ...options, archive: { ...options.archive, initializer: 'B' } });
  await assert.rejects(validateHeaderImports(broken, read), /archive\.js → B/);
  modules['./native.js'] = modules['./native.js'].replace('service as c,', '');
  await assert.rejects(validateHeaderImports(header, read), /native\.js → c/);
});

test('项目连续创建聊天后身份独立，结构不匹配时拒绝补丁', () => {
  const native = 'function reset(scope,{clientNewThreadId:client,draftThreadLocationId:slot}){'
    + 'if(scope.get(drafts,slot)!==client)return;let next=generate();save(scope,slot,next),scope.set(drafts,slot,next)}'
    + 'function following(){}';
  assert.throws(() => patchProjectDraftReset('function other(){}'), /数量异常：0/);
  assert.throws(() => patchProjectDraftReset(native + native), /数量异常：2/);
  checkNativeDraftLifecycle(patchProjectDraftReset(native));
});

test('拆分路由和输入作用域保留项目草稿身份及原生首页和聊天行为', () => {
  const routeSource = 'function routeA(e){if(e.orbitId!=null)return orbit(e);switch(e.routeKind){case`home`:return e.homeDraftClientThreadId??e.draftThreadLocationId??draft({entrypoint:`home`});case`new-thread-panel`:return draft({entrypoint:`panel`})}}'
    + 'function routeB(e){switch(e.routeKind){case`home`:return e.draftThreadLocationId??draft({entrypoint:`home`});case`new-thread-panel`:return draft({entrypoint:`panel`})}}'
    + 'function route({pathname:e,routeTemplate:t,search:n=``}){return{routeKind:`home`}}'
    + 'function resolve(e){if(client(e))return e;if(nativeDraft(e))return get(atom,e);let n=null;return n}'
    + 'function reset(e,{clientNewThreadId:t,draftThreadLocationId:r}){if(e.get(drafts,r)!==t)return;e.set(drafts,r,generate())}';
  const composerSource = 'function keyA(e){switch(e.kind){case`new`:return`home`;case`local`:return e.id}}'
    + 'function keyB(e){switch(e.kind){case`new`:return`panel`;case`local`:return e.id}}'
    + 'function keyC(e){if(e.kind!==`new`)return e.id;return`native`}'
    + 'function context(e,t,n){let r=conversation(e);switch(e.routeKind){case`home`:return{kind:`new`};default:return{kind:`local`,id:r}}}';
  const scope = vm.createContext({
    draft: ({ entrypoint }) => entrypoint, client: () => false, nativeDraft: () => false,
    get: (_atom, key) => `client:${key}`, atom: {}, conversation: (route) => route.id,
    __vscodexLayerBridge: { projectRoute: () => null },
  });
  vm.runInContext(patchSplitRouteScope(routeSource) + patchSplitComposerScope(composerSource), scope);
  for (const [routeKind, cwd] of [['home', '/home/project'], ['new-thread-panel', '/home/Project']]) {
    const key = `vscodex-layer-new:${routeKind}:${cwd}`;
    const route = { routeKind, vclDraftKey: key, vclProjectCwd: cwd };
    assert.equal(scope.routeA(route), key); assert.equal(scope.routeB(route), key);
    assert.equal(scope.resolve(key), `client:${key}`);
    const context = scope.context(route, {}, 'mentioned-chat');
    assert.equal(context.kind, 'new'); assert.equal(context.vclProjectCwd, cwd);
    assert.equal(context.browserTabMentionConversationId, 'mentioned-chat');
    for (const readKey of [scope.keyA, scope.keyB, scope.keyC]) assert.equal(readKey(context), key);
  }
  assert.equal(scope.routeA({ routeKind: 'home', homeDraftClientThreadId: 'native-client' }), 'native-client');
  assert.equal(scope.routeB({ routeKind: 'home', draftThreadLocationId: 'native-slot' }), 'native-slot');
  assert.equal(scope.routeA({ routeKind: 'new-thread-panel' }), 'panel');
  for (const readKey of [scope.keyA, scope.keyB, scope.keyC]) assert.equal(readKey({ kind: 'local', id: 'chat' }), 'chat');
  for (const [patch, source] of [[patchSplitRouteScope, routeSource], [patchSplitComposerScope, composerSource]]) {
    assert.throws(() => patch('unknown layout'), /数量异常/);
    assert.throws(() => patch(source + source), /数量异常/);
  }
});

async function extension(parent, version, files = {}, platform = 'win32-x64') {
  const root = path.join(parent, `openai.chatgpt-${version}-${platform}`);
  await fs.mkdir(path.join(root, 'out'), { recursive: true });
  await fs.mkdir(path.join(root, 'webview', 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'chatgpt', publisher: 'openai', version }));
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
  return root;
}

test('发现当前未过期的最高版本而不选择残留目录', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-discovery-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  await extension(parent, '26.5930.51102');
  const current = await extension(parent, '26.51002.51308');
  await extension(parent, '26.6000.10000');
  await fs.writeFile(path.join(parent, '.obsolete'), JSON.stringify({
    'openai.chatgpt-26.5930.51102': true,
    'openai.chatgpt-26.6000.10000': true,
  }));
  const result = await findInstalledExtension(parent, { platform: 'win32-x64' });
  assert.equal(result.root, current);
  assert.equal(result.version, '26.51002.51308');
  assert.equal(result.candidates.length, 3);
});

test('空过期标记视为无标记，损坏的安装或过期清单仍拒绝并指出文件', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-empty-obsolete-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const current = await extension(parent, '26.1.0');
  await extension(parent, '99.1.0');
  const installed = JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, version: '26.1.0',
    relativeLocation: path.basename(current) }]);
  await fs.writeFile(path.join(parent, 'extensions.json'), installed);
  for (const empty of ['', ' \r\n\t']) {
    await fs.writeFile(path.join(parent, '.obsolete'), empty);
    assert.equal((await findInstalledExtension(parent, { platform: 'win32-x64' })).root, current,
      '空标记不得绕过安装清单选择残留高版本');
  }
  for (const [name, content] of [['.obsolete', '{'], ['extensions.json', '']]) {
    await fs.writeFile(path.join(parent, name), content);
    await assert.rejects(findInstalledExtension(parent, { platform: 'win32-x64' }), (error) => {
      assert.ok(error instanceof SyntaxError);
      assert.ok(error.message.includes(path.join(parent, name)));
      return true;
    });
    await fs.writeFile(path.join(parent, '.obsolete'), '{}');
    await fs.writeFile(path.join(parent, 'extensions.json'), installed);
  }
});

test('ARM64 发现遵循安装清单、平台和过期标记，多个宿主拒绝猜测', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-arm64-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const remote = path.join(home, '.vscode-server', 'extensions');
  const current = await extension(remote, '26.51007.21434', {}, 'linux-arm64');
  await extension(remote, '99.1.0', {}, 'linux-arm64');
  await extension(remote, '99.2.0', {}, 'win32-x64');
  const old = await extension(remote, '99.3.0', {}, 'linux-arm64');
  const record = (root, version) => ({ identifier: { id: 'openai.chatgpt' }, version,
    relativeLocation: path.basename(root), metadata: { targetPlatform: 'linux-arm64' } });
  await fs.writeFile(path.join(remote, 'extensions.json'), JSON.stringify([
    record(current, '26.51007.21434'), record(old, '99.3.0'),
  ]));
  await fs.writeFile(path.join(remote, '.obsolete'), JSON.stringify({ [path.basename(old)]: true }));
  const options = { home, platform: 'linux-arm64' };
  assert.equal((await findInstalledExtension(undefined, options)).root, current);
  const local = path.join(home, '.vscode', 'extensions');
  await extension(local, '26.51007.21434', {}, 'linux-arm64');
  await assert.rejects(findInstalledExtension(undefined, options), /无法确定当前宿主/);
  assert.equal((await findInstalledExtension(remote, options)).root, current);
  await fs.writeFile(path.join(remote, 'extensions.json'), '[]');
  await assert.rejects(findInstalledExtension(remote, options), /未找到/);
});

test('终端选择宿主只使用各目录当前版本，取消及非交互环境不猜测目标', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-selection-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const options = { home, platform: 'linux-arm64' };
  const remoteParent = path.join(home, '.vscode-server', 'extensions');
  const remote = await extension(remoteParent, '26.2.0', {}, options.platform);
  // 单目录及显式目录不应进入选择器。
  assert.equal((await findInstalledExtension(undefined, { ...options, select: () => assert.fail('不应询问') })).root, remote);
  await extension(remoteParent, '26.1.0', {}, options.platform);
  const obsolete = await extension(remoteParent, '99.0.0', {}, options.platform);
  await fs.writeFile(path.join(remoteParent, '.obsolete'), JSON.stringify({ [path.basename(obsolete)]: true }));
  const local = await extension(path.join(home, '.vscode', 'extensions'), '26.3.0', {}, options.platform);
  assert.equal((await findInstalledExtension(remoteParent, { ...options, select: () => assert.fail('不应询问') })).root, remote);
  await assert.rejects(findInstalledExtension(undefined, { ...options, select: () => ({ root: obsolete }) }), /未选择有效/);

  async function choose(answer, tty = true) {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = output.isTTY = tty;
    let menu = '';
    output.on('data', (chunk) => { menu += chunk; });
    const result = findExtension({ ...options, input, output });
    // 异步送入模拟终端输入；发现目录期间由流保留输入。
    const send = setImmediate(() => input.end(answer));
    try { return { root: await result, menu }; }
    finally { clearImmediate(send); input.destroy(); output.destroy(); }
  }
  const selectedRemote = await choose('1\n');
  assert.equal(selectedRemote.root, remote);
  assert.match(selectedRemote.menu, /VS Code Server（Remote SSH）/);
  assert.match(selectedRemote.menu, /本机桌面 VS Code/);
  assert.ok(selectedRemote.menu.includes(local));
  assert.ok(!selectedRemote.menu.includes(obsolete));
  const selectedLocal = await choose('0\n3\n1.5\nno\n2\n');
  assert.equal(selectedLocal.root, local);
  assert.match(selectedLocal.menu, /编号无效/);
  for (const answer of ['q\n', '\n', '']) await assert.rejects(choose(answer), /已取消/);
  await assert.rejects(choose('1\n', false), /交互终端/);
});

for (const [route, composer] of [
  ['app-initial-route.js', 'app-initial-composer.js'],
  ['app-runtime-route.js', 'composer-content-current.js'],
]) test(`只读探测报告动态入口和语义候选文件：${route}`, async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vscodex-probe-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = await extension(parent, 'future', {
    'out/extension.js': 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),rest',
    'webview/index.html': '<script type="module" src="./assets/index-new.js"></script>',
    [`webview/assets/${route}`]: 'navigate-to-route /extension/panel/new routeTemplate',
    [`webview/assets/${composer}`]: 'activeWorkspaceRoot selectedRemoteProject workspaceRoots',
    'webview/assets/app-runtime-decoy.js': 'navigate-to-route /extension/panel/new',
    'webview/assets/composer-content-decoy.js': 'activeWorkspaceRoot workspaceRoots',
    'webview/assets/header-new.js': 'header.recentChats tasksQuery',
  });
  const result = await probeCompatibility(root, 'supported');
  assert.equal(result.mode, 'unknown-version');
  assert.equal(result.compatible, false);
  assert.deepEqual(result.discovered.moduleEntries, ['./assets/index-new.js']);
  assert.deepEqual(result.discovered.routeCandidates, [route]);
  assert.deepEqual(result.discovered.composerCandidates, [composer]);
  assert.deepEqual(result.discovered.headerCandidates, ['header-new.js']);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test('推理摘要支持新旧模块，结构缺失、歧义或重复补丁时拒绝转换', async (t) => {
  const activity = 'function classify($,{dynamicToolCallRenderer:a,includeGeneratedImages:b=!1,mcpServerStatuses:c}={}){switch($.type){case`user-message`:return wrap($,`standalone`);case`reasoning`:return null}}function wrap(item,grouping){return{item,grouping}}';
  const renderer = 'function render(p){let t=(0,Cache.c)(3),{item:$,conversationId:a,cwd:b,hideCodeBlocks:c,hostId:d}=p,n=!$.completed,u=n?``:strip($.content),v=trim($.content).trimStart(),[x,set]=(0,React.useState)(!1),g=!n&&!!u,y=n?!!v&&(s==null||s===`resumed`):x,z=y?(0,JSX.jsx)(Scroll,{items:[{key:`reasoning-markdown`,node:md}],autoScrollToBottom:n,contentClassName:`gap-0`,maxHeightByState:{preview:`8.75rem`,expanded:`8.75rem`,collapsed:`0px`},viewState:`expanded`,className:`[--edge-fade-distance:1rem]`}):null;return(0,JSX.jsx)(Frame,{disclosure:{onToggle:()=>set(!x)},text:v,body:z})}function next(){}';
  for (const [transform, source] of [[patchReasoningActivity, activity], [patchReasoningRenderer, renderer]]) {
    assert.throws(() => transform('unknown layout'), /数量异常/);
    assert.throws(() => transform(source + source), /数量异常/);
    const patched = transform(source).content;
    assert.throws(() => transform(patched), /数量异常/);
  }
  assert.throws(() => patchReasoningRenderer(renderer.replace('onToggle:', 'changedControl:')), /缺少/);
  assert.throws(() => patchReasoningRenderer(renderer.replace('8.75rem', 'unknown')), /固定高度滚动容器/);
  const assistant = 'function render(p){let t=(0,Cache.c)(3),{item:n,assistantCopyText:r,turnId:i,cwd:d,conversationId:l,hostId:f}=p;return(0,JSX.jsx)(Body,{item:n})}function next(){}';
  assert.throws(() => patchReadTarget('unknown layout'), /数量异常/);
  assert.throws(() => patchReadTarget(assistant + assistant), /数量异常/);
  assert.throws(() => patchReadTarget(patchReadTarget(assistant).content), /重复转换/);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'vcl-reasoning-layout-'));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  for (const prefix of ['sites-end-resource-', 'subagent-activity-chip-group-']) {
    const rendererPath = `webview/assets/${prefix}fixture.js`;
    const root = await extension(parent, prefix, {
      'webview/assets/agent-activity-item-fixture.js': activity,
      [rendererPath]: renderer + assistant.replace('function next(){}', 'function finish(){}'),
    });
    const plan = await buildReasoningPatchFiles(root);
    assert.equal(plan.compatibility.renderer, rendererPath);
    assert.ok(plan.files[1].content.includes('data-vcl-reasoning-summary'));
    assert.ok(plan.files[1].content.includes('data-vcl-reply-thread'));
    const other = prefix === 'sites-end-resource-' ? 'subagent-activity-chip-group-' : 'sites-end-resource-';
    await fs.copyFile(path.join(root, rendererPath), path.join(root, 'webview/assets', `${other}ambiguous.js`));
    await assert.rejects(buildReasoningPatchFiles(root), /数量异常：2/);
  }
});
