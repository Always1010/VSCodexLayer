import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

// Execute the actual patched native component with inert editor/React adapters.
// No extension host, browser window, transcript, clipboard or model is touched.
export async function checkNativeChatMenu(plan) {
  const menu = plan.files.find((file) => file.path === plan.compatibility.chatMenu.menu).content.toString();
  const name = plan.compatibility.chatMenu.component;
  const start = menu.indexOf(`function ${name}(`);
  const end = menu.indexOf('}function ', start);
  const body = menu.slice(start, end + 1);
  const local = (pattern) => {
    const match = pattern.exec(body);
    assert.ok(match, `原生菜单接入点缺失：${pattern}`);
    return match[1];
  };
  const cache = local(/\(0,([\w$]+)\.c\)\(/);
  const react = local(/\(0,([\w$]+)\.useState\)\(/);
  const jsx = local(/\(0,([\w$]+)\.jsx\)\(/);
  const scopeHook = local(/([\w$]+)\(([\w$]+)\),[\w$]+=\1\(/);
  const actions = local(/\{cancelPendingWorktree:[\w$]+\}=([\w$]+)\(\)/);
  const actionHook = local(/([\w$]+)\(\),\{cancelPendingWorktree:/);
  const pinHook = local(/\{isPinned:[\w$]+,togglePin:[\w$]+\}=([\w$]+)\(/);
  const atomHook = local(/([\w$]+)\([\w$]+,[\w$]+\)\?\.type===`active`/);
  const unreadState = local(/([\w$]+)\.canMarkUnread/);
  const unreadAtom = local(new RegExp(`let ${unreadState}=[\\w$]+\\(([\\w$]+),`));
  const menuBuilder = local(/await ([\w$]+)\(\{scope:/);
  const dialog = local(/([\w$]+)\([\w$]+,[\w$]+,\{draftKey:/);
  const command = local(/__vclLayerMenu\|\|([\w$]+)\(`rename-thread`/);
  const shortcut = local(/__vclLayerMenu\|\|([\w$]+)\(`markThreadUnread`/);
  const automation = local(/await ([\w$]+)\(`list-automations`\)/);
  const intl = local(/[\w$]+=([\w$]+)\(\),[\w$]+=[\w$]+&&!1/);
  const scope = { value: { routeKind: 'local-thread', conversationId: 'current' }, get: () => null };
  const calls = { commands: 0, targets: [], archives: [], titles: [], dialogs: [] };
  const nativeActions = {
    archiveThread(options) { calls.archives.push(options); },
    renameThread(options) { calls.titles.push(options); return Promise.resolve(); },
    markThreadAsUnread() {}, copyAppLink() {}, copyWorkingDirectory() {}, copyConversationMarkdown() {},
  };
  let running = false;
  const stateChanges = [];
  const activeAtom = local(new RegExp(`${atomHook}\\(([\\w$]+),[\\w$]+\\)\\?\\.type===`));
  const mocks = {};
  for (const match of menu.matchAll(/import\{([^}]+)\}from/g)) {
    for (const entry of match[1].split(',')) {
      const alias = entry.trim().split(' as ').at(-1);
      mocks[alias] = Object.assign(() => null, { tag: alias });
    }
  }
  Object.assign(mocks, {
    [cache]: { c: (size) => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) },
    [react]: { useState: (value) => [value, (next) => { stateChanges.push(next); }] },
    [jsx]: { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' },
    [scopeHook]: () => scope,
    [actions]: () => ({ cancelPendingWorktree() {} }),
    [actionHook]: () => nativeActions,
    [pinHook]: () => ({ isPinned: false, togglePin() {} }),
    [atomHook]: (atom) => atom?.tag === unreadAtom ? { canMarkUnread: false }
      : atom?.tag === activeAtom && running ? { type: 'active' } : null,
    [command]: () => { calls.commands += 1; },
    [shortcut]: () => { calls.commands += 1; },
    [automation]: async () => ({ items: [] }),
    [dialog]: (_scope, _component, options) => { calls.dialogs.push(options); },
    [intl]: () => ({ formatMessage: (message) => message?.defaultMessage ?? '菜单' }),
    [menuBuilder]: (options) => {
      calls.targets.push(options.target);
      return [{ id: 'rename-thread', onSelect: options.onRename }, { id: 'delete-thread' },
        { id: 'copy', submenu: [{ id: 'copy-deeplink', onSelect() {} }] },
        { id: 'archive-thread', onSelect: options.onArchive }];
    },
  });
  const context = vm.createContext({ ...mocks, queueMicrotask, URLSearchParams,
    document: { querySelector: () => null },
    acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }) });
  vm.runInContext(await fs.readFile(new URL('../webview/bootstrap.js', import.meta.url), 'utf8'), context);
  vm.runInContext(body, context);
  function findMenu(node) {
    if (node?.props?.getItems) return node.props;
    const children = node?.props?.children;
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child && typeof child === 'object') { const found = findMenu(child); if (found) return found; }
    }
    return null;
  }
  const props = { __vclLayerMenu: true, conversationId: 'other', hostId: 'local', cwd: '/other',
    title: '其他聊天', canPin: false, archiveNavigation: 'stay' };
  const rendered = context[name](props);
  const dropdown = findMenu(rendered);
  assert.ok(dropdown, '原生菜单必须渲染');
  const items = await dropdown.getItems();
  assert.equal(calls.commands, 0, '左侧菜单不能重定向当前聊天的全局快捷键');
  assert.equal(items.some((item) => item.id === 'delete-thread'), false);
  assert.equal(calls.targets[0].conversationId, 'other');
  assert.equal(calls.targets[0].hostId, 'local');
  assert.equal(calls.targets[0].cwd, '/other');
  items.find((item) => item.id === 'rename-thread').onSelect();
  assert.equal(calls.dialogs[0].initialValue, '其他聊天');
  await calls.dialogs[0].onSave('新标题');
  assert.equal(calls.titles[0].conversationId, 'other');
  assert.equal(calls.titles[0].title, '新标题');
  let archived;
  context.__vscodexLayerBridge.subscribeThreadArchived((id) => { archived = id; });
  items.find((item) => item.id === 'archive-thread').onSelect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.archives[0].conversationId, 'other');
  assert.equal(calls.archives[0].onArchiveStart, undefined, '归档开始时不能导航或删除列表');
  assert.equal(archived, undefined);
  calls.archives[0].onArchiveSuccess();
  assert.equal(archived, 'other');
  running = true;
  const runningMenu = await findMenu(context[name](props)).getItems();
  runningMenu.find((item) => item.id === 'archive-thread').onSelect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.archives.length, 1, '运行中的聊天必须先走原生确认，不能直接归档');
  assert.ok(stateChanges.includes(true), '原生归档确认必须打开');
  running = false;
  context[name]({ ...props, __vclLayerMenu: false, conversationId: 'current' });
  assert.ok(calls.commands > 0, '官方当前聊天命令必须保持注册');

  const header = plan.files.find((file) => /webview\/assets\/header-/.test(file.path)).content.toString();
  const wrapper = header.slice(header.indexOf('let __vclMenuBoundary;'));
  const surface = {};
  const portalContext = vm.createContext({
    __vclReact: () => ({ useRef: () => ({ current: surface }), useEffect: (callback) => callback(),
      useSyncExternalStore: (_subscribe, snapshot) => snapshot(), Component: class {} }),
    __vclJsx: () => ({ jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' }),
    __vclMenuInit() {}, __vclMenu: 'native-menu',
    __vclDom: () => ({ createPortal: (node, container) => ({ node, container }) }),
    globalThis: { __vscodexLayerBridge: context.__vscodexLayerBridge },
  });
  vm.runInContext(wrapper, portalContext);
  assert.equal(portalContext.__vclMenuPortal(), null);
  const container = { isConnected: true };
  context.__vscodexLayerBridge.openThreadMenu({ id: 'other', title: '标题', cwd: '/other' }, container);
  const portal = portalContext.__vclMenuPortal();
  assert.equal(portal.container, container, '菜单必须挂载到左侧按钮位置');
  assert.equal(portal.node.props.children.props.conversationId, 'other');
  assert.equal(portal.node.props.children.props.__vclLayerMenu, true);
  assert.equal(portal.node.props.children.props.archiveNavigation, 'stay');

  // Execute the generated restoration bridge inside the same native providers.
  const restored = [], invalidated = [], cleanup = [];
  let restoreError;
  class OpenError extends Error {}
  const pins = {};
  const nativeScope = { get: (atom) => { assert.equal(atom, pins); return true; },
    queryClient: { invalidateQueries: async (options) => { invalidated.push(options.queryKey); } } };
  const archiveContext = vm.createContext({
    __vclReact: () => ({ useRef: () => ({ current: surface }), useEffect: (callback) => cleanup.push(callback()) }),
    __vclArchiveInit() {}, __vclArchiveScope: () => nativeScope, __vclArchiveScopeAtom: {},
    __vclArchiveService: (scope, hostId) => {
      assert.equal(scope, nativeScope); assert.equal(hostId, 'local');
      return { async unarchiveConversation(id, options) {
        restored.push({ id, options }); if (restoreError) throw restoreError;
      } };
    },
    __vclArchivePins: pins, __vclArchiveOpenError: OpenError,
    globalThis: { __vscodexLayerBridge: context.__vscodexLayerBridge },
  });
  vm.runInContext(wrapper, archiveContext);
  archiveContext.__vclArchiveActions();
  const restoredResult = await context.__vscodexLayerBridge.restoreArchivedThread({ id: 'saved' });
  assert.equal(restoredResult.restored, true); assert.equal(restoredResult.openable, true);
  assert.equal(restored[0].id, 'saved'); assert.equal(restored[0].options.useAppServerPins, true);
  restoreError = new Error('恢复失败');
  await assert.rejects(context.__vscodexLayerBridge.restoreArchivedThread({ id: 'other' }), /恢复失败/);
  restoreError = new OpenError('已恢复但加载失败');
  const partial = await context.__vscodexLayerBridge.restoreArchivedThread({ id: 'partial' });
  assert.equal(partial.restored, true); assert.equal(partial.openable, false);
  assert.equal(invalidated.length, 3, '成功、失败和部分恢复后都刷新原生归档缓存');
  cleanup[0]();
  await assert.rejects(context.__vscodexLayerBridge.restoreArchivedThread({ id: 'saved' }), /尚未就绪/);
}
