import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { readUnpatched } from '../lib/patch-engine.mjs';

// Execute the native read-only entry without opening VS Code or resuming work.
// The complete provider tree still needs acceptance in the actual IDE.
export async function checkNativeAgentDetail(plan, directory) {
  const detail = plan.compatibility.agentDetail;
  if (!detail?.supported) return;
  const header = plan.files.find((file) => file.content.toString().includes('let __vclAgentBoundary;')).content.toString();
  const hydration = [], scope = { value: { routeKind: 'local-thread', conversationId: 'root' } }, cleanups = [];
  const ref = { current: {} };
  const jsx = { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' };
  const context = vm.createContext({ document: { querySelector: () => null }, queueMicrotask,
    acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
    __vclReact: () => ({ useRef: () => ref, useEffect: (handler) => { cleanups.push(handler()); },
      useSyncExternalStore: (_subscribe, get) => get(), Component: class {} }),
    __vclJsx: () => jsx, __vclDom: () => ({ createPortal: (node, container) => ({ node, container }) }),
    __vclArchiveInit() {}, __vclArchiveScopeAtom: {}, __vclArchiveScope: () => scope,
    __vclArchiveService(value, host) {
      assert.equal(value, scope); assert.equal(host, 'local');
      return { async hydrateBackgroundThreads(ids, options) { hydration.push({ ids: [...ids], options: { ...options } }); } };
    },
    __vclMenuNoop: () => () => {}, __vclMenuOff: () => null,
    __vclAgentThread: 'native-thread', __vclAgentThreadInit() {},
  });
  vm.runInContext(await fs.readFile(new URL('../webview/bootstrap.js', import.meta.url), 'utf8'), context);
  vm.runInContext(header.slice(header.indexOf('let __vclAgentBoundary;')), context);
  assert.equal(context.__vclAgentPortal(), null);
  const bridge = context.__vscodexLayerBridge, container = { isConnected: true };
  await bridge.openAgentDetail({ rootId: 'root', threadId: 'child' }, container);
  const portal = context.__vclAgentPortal();
  assert.equal(portal.container, container);
  const props = portal.node.props.children.props;
  assert.equal(props.conversationId, 'child'); assert.equal(props.hostId, 'local');
  assert.equal(props.canInteract, false); assert.equal(props.shouldResume, false);
  assert.deepEqual(hydration, [{ ids: ['root', 'child'], options: { includeTurns: true, refreshExisting: true } }]);
  let selected; bridge.setAgentDetailSelectHandler((id) => { selected = id; });
  props.onOpenBackgroundAgent({ conversationId: 'nested' }); assert.equal(selected, 'nested');
  bridge.closeAgentDetail(); assert.equal(context.__vclAgentPortal(), null);
  for (const cleanup of cleanups) cleanup?.();

  const source = (await readUnpatched(directory, detail.file)).toString();
  const exports = /export\{([^}]+)\}/.exec(source)?.[1] ?? '';
  const local = new RegExp(`([A-Za-z_$][\\w$]*) as ${detail.component}(?=,|$)`).exec(exports)?.[1];
  assert.ok(local, '原生子聊天导出缺失');
  const start = source.indexOf(`function ${local}(`), end = source.indexOf('}function ', start);
  assert.ok(start >= 0 && end > start, '原生子聊天组件边界缺失');
  const body = source.slice(start, end + 1);
  const cache = /\(0,([A-Za-z_$][\w$]*)\.c\)\(/.exec(body)?.[1];
  const jsxName = /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(/.exec(body)?.[1];
  const resume = /let\{isResuming:[^}]+\}=([A-Za-z_$][\w$]*)\(/.exec(body)?.[1];
  assert.ok(cache && jsxName && resume, '原生只读行为检查接入点缺失');
  const environment = {};
  for (const token of body.match(/[A-Za-z_$][\w$]*/g)) environment[token] = () => scope;
  const resumeTargets = [];
  Object.assign(environment, { Symbol, [cache]: { c: (size) => Array(size).fill(Symbol.for('react.memo_cache_sentinel')) },
    [jsxName]: jsx, [resume]: (id) => { resumeTargets.push(id); return {}; } });
  const native = vm.createContext(environment);
  vm.runInContext(body, native);
  const tree = native[local]({ canInteract: false, shouldResume: false, conversationId: 'child', hostId: 'local' });
  const nodes = [];
  const walk = (node) => { if (!node || typeof node !== 'object') return; nodes.push(node); for (const child of [node.props?.children].flat()) walk(child); };
  walk(tree);
  assert.ok(nodes.some((node) => node.props?.isReadOnly === true && node.props?.showComposer === false), '真实组件必须隐藏输入框并保持只读');
  assert.deepEqual(resumeTargets, [null], '真实组件不能主动恢复执行子线程');
}
