import fs from 'node:fs/promises';
import path from 'node:path';
import { readUnpatched, sha256 } from '../lib/patch-engine.mjs';

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function unique(matches, label) {
  if (matches.length !== 1) throw new Error(`${label}接入点数量异常：${matches.length}`);
  return matches[0];
}
function exportName(source, local) {
  const bindings = [...source.matchAll(/export\{([^}]+)\}/g)].map((match) => match[1]).join(',');
  return unique([...bindings.matchAll(new RegExp(`(?:^|,)${escape(local)} as (${identifier})(?=,|$)`, 'g'))], '菜单依赖导出')[1];
}
function imported(source, local) {
  for (const match of source.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)) {
    const found = new RegExp(`(?:^|,)(${identifier}) as ${escape(local)}(?:,|$)`).exec(match[1]);
    if (found) return { exported: found[1], file: match[2] };
  }
  throw new Error(`菜单依赖无法识别：${local}`);
}

export function patchThreadMenu(source) {
  const signature = unique([...source.matchAll(new RegExp(`function (${identifier})\\((${identifier})\\)\\{let ${identifier}=\\(0,${identifier}\\.c\\)\\(\\d+\\),\\{conversationId:${identifier},getConversationMarkdown:`, 'g'))], '原生聊天菜单组件');
  const props = signature[2];
  const end = source.indexOf('}function ', signature.index);
  if (end < 0) throw new Error('原生聊天菜单组件边界异常。');
  let body = source.slice(signature.index, end + 1);
  body = body.replace(signature[0], signature[0].replace('{let ',
    `{let __vclLayerMenu=${props}.__vclLayerMenu===true,__vclMenuToken=${props}.__vclMenuToken;let `));
  const command = unique([...body.matchAll(new RegExp(`(${identifier})\\(\`rename-thread\`,`, 'g'))], '菜单命令注册')[1];
  const shortcut = unique([...body.matchAll(new RegExp(`(${identifier})\\(\`markThreadUnread\`,`, 'g'))], '菜单快捷键注册')[1];
  // The portal instance always has this flag. It must not register another set of
  // global shortcuts that would retarget the active chat's native commands.
  for (const helper of [command, shortcut]) body = body.replace(new RegExp(`\\b${escape(helper)}\\(`, 'g'), `__vclLayerMenu||${helper}(`);
  const jsx = unique([...body.matchAll(new RegExp(`(${identifier})=\\(0,(${identifier})\\.jsx\\)\\(${identifier},\\{preserveBrowserContextMenu:!0,`, 'g'))], '原生菜单入口')[2];
  const menuGetter = unique([...body.matchAll(new RegExp(`getItems:(${identifier}),renderItem:`, 'g'))], '菜单项读取')[1];
  // The native sidebar surface includes permanent deletion with its own capability
  // checks and confirmation dialog; the header surface only offers archiving.
  const menuBuilder = unique([...body.matchAll(new RegExp(`await ${identifier}\\(\\{scope:${identifier},surface:\`header\``, 'g'))], '原生侧栏聊天操作');
  body = body.replace(menuBuilder[0], menuBuilder[0].replace('surface:`header`', 'surface:__vclLayerMenu?`sidebar`:`header`'));
  body = body.replace(`getItems:${menuGetter},renderItem:`,
    `getItems:__vclLayerMenu?()=>Promise.resolve().then(()=>${menuGetter}()).then(items=>{let result=globalThis.__vscodexLayerBridge.filterThreadMenu(items,${props}.conversationId,__vclMenuToken);`
    + `if(!result.length)throw new Error("此聊天暂无可用操作。");return result}).catch(error=>{globalThis.__vscodexLayerBridge?.threadMenuError(error.message,__vclMenuToken);throw error}):${menuGetter},renderItem:`);
  const archive = unique([...body.matchAll(new RegExp(`conversationId:(${identifier}),hostId:(${identifier}),source:(${identifier}),onArchiveStart:(${identifier}),appHistory:`, 'g'))], '归档完成回调');
  body = body.replace(archive[0], `conversationId:${archive[1]},hostId:${archive[2]},source:${archive[3]},`
    + `onArchiveStart:__vclLayerMenu?undefined:${archive[4]},`
    + `onArchiveSuccess:__vclLayerMenu?()=>globalThis.__vscodexLayerBridge?.threadArchived(${archive[1]}):undefined,appHistory:`);
  const pinShortcut = unique([...body.matchAll(new RegExp(`(${identifier})=(${identifier})==null\\?null:\\(0,${escape(jsx)}\\.jsx\\)\\((${identifier}),\\{enabled:`, 'g'))], '置顶快捷键组件');
  body = body.replace(pinShortcut[0], `${pinShortcut[1]}=${pinShortcut[2]}==null||__vclLayerMenu?null:(0,${jsx}.jsx)(${pinShortcut[3]},{enabled:`);
  const react = unique([...body.matchAll(new RegExp(`\\(0,(${identifier})\\.useState\\)\\(null\\)`, 'g'))].slice(0, 1), '菜单 React 状态')[1];
  const active = unique([...body.matchAll(new RegExp(`${identifier}\\((${identifier}),${identifier}\\)\\?\\.type===\`active\``, 'g'))], '归档运行状态')[1];
  const restricted = unique([...body.matchAll(new RegExp(`\\b${identifier}\\.get\\((${identifier}),\\{hostId:${identifier},threadId:${identifier}\\}\\)\\)?(?:\\{|\\?)`, 'g'))], '归档受限聊天')[1];
  const automation = unique([...body.matchAll(new RegExp(`await (${identifier})\\((\`list-automations\`)?\\);${identifier}=(${identifier})\\(\\{automations:`, 'g'))], '归档关联任务检查');
  const batch = { active: imported(source, active), restricted: imported(source, restricted),
    automations: imported(source, automation[1]), matchAutomation: imported(source, automation[3]),
    automationCommand: !!automation[2] };
  // Hook-free metadata lets the header mount this component within native providers.
  return { content: source.slice(0, signature.index) + body + source.slice(end + 1), component: signature[1],
    initializer: exportName(source, unique([...source.matchAll(new RegExp(`function (${identifier})\\(\\)\\{return\\(\\1=${identifier}\\(\\(\\(\\)=>\\{[^{}]*${escape(react)}=(${identifier})\\(\\)`, 'g'))], '菜单初始化函数')[1]),
    react: imported(source, unique([...source.matchAll(new RegExp(`${escape(react)}=(${identifier})\\(\\)`, 'g'))], 'React 依赖')[1]),
    jsx: imported(source, unique([...source.matchAll(new RegExp(`${escape(jsx)}=(${identifier})\\(\\)`, 'g'))], 'JSX 依赖')[1]), batch };
}

export function archiveDependencies(source) {
  const restore = unique([...source.matchAll(new RegExp(`\\b(${identifier})\\((${identifier}),${identifier}\\)\\.unarchiveConversation\\(${identifier},\\{useAppServerPins:\\2\\.get\\((${identifier})\\)\\}\\)`, 'g'))], '原生归档恢复服务');
  const scope = unique([...source.matchAll(new RegExp(`\\b${escape(restore[2])}=(${identifier})\\((${identifier})\\)`, 'g'))], '原生归档恢复作用域');
  const openError = [...new Set([...source.matchAll(new RegExp(`instanceof (${identifier})`, 'g'))].map((match) => match[1]))];
  const predicate = [...source.matchAll(new RegExp(`\\?\\.\\((${identifier})\\((${identifier})\\)\\?\`restored\`:null\\),\\1\\(\\2\\)\\?`, 'g'))];
  const errorLocal = predicate.length ? unique(predicate, '原生恢复后加载错误判断')[1]
    : unique(openError, '原生恢复后加载错误');
  const initializer = unique([...source.matchAll(new RegExp(`export\\{(${identifier}) as n,`, 'g'))], '原生归档恢复初始化')[1];
  return { initializer: exportName(source, initializer), scope: imported(source, scope[1]), scopeAtom: imported(source, scope[2]),
    service: imported(source, restore[1]), pins: imported(source, restore[3]),
    openError: imported(source, errorLocal), openErrorKind: predicate.length ? 'predicate' : 'constructor' };
}

export function patchMenuHeader(source, { menuPath, menu, dom, archive }) {
  const exported = unique([...source.matchAll(new RegExp(`export\\{[^}]*?(${identifier}) as t(?=[,}])`, 'g'))], '首页导出组件')[1];
  const imports = `import{${menu.initializer} as __vclMenuInit,${menu.componentExport} as __vclMenu}from"./${path.basename(menuPath)}";`
    + `import{${menu.react.exported} as __vclReact}from"${menu.react.file}";`
    + `import{${menu.jsx.exported} as __vclJsx}from"${menu.jsx.file}";`
    + `import{${dom.exported} as __vclDom}from"${dom.file}";`
    + `import{${archive.initializer} as __vclArchiveInit}from"./${path.basename(archive.path)}";`
    + Object.entries({ scope: '__vclArchiveScope', scopeAtom: '__vclArchiveScopeAtom', service: '__vclArchiveService',
      pins: '__vclArchivePins', openError: '__vclArchiveOpenError' }).map(([key, alias]) =>
      `import{${archive[key].exported} as ${alias}}from"${archive[key].file}";`).join('')
    + Object.entries({ active: '__vclArchiveActive', restricted: '__vclArchiveRestricted',
      automations: '__vclArchiveAutomations', matchAutomation: '__vclArchiveMatchAutomation' }).map(([key, alias]) =>
      `import{${menu.batch[key].exported} as ${alias}}from"${menu.batch[key].file}";`).join('');
  const wrapper = `let __vclMenuBoundary;function __vclMenuOff(){return null}function __vclMenuNoop(){return()=>{}}`
    + `function __vclMenuPortal(){let R=__vclReact(),J=__vclJsx(),bridge=globalThis.__vscodexLayerBridge,surface=R.useRef({}).current;`
    + `R.useEffect(()=>bridge?.registerThreadMenuSurface(surface),[bridge,surface]);`
    + `let target=R.useSyncExternalStore(bridge?.subscribeThreadMenu??__vclMenuNoop,bridge?.threadMenuTarget??__vclMenuOff,__vclMenuOff);`
    + `if(!target||target.surface!==surface||!target.container.isConnected)return null;__vclMenuInit();`
    + `if(!__vclMenuBoundary)__vclMenuBoundary=class extends R.Component{constructor(p){super(p);this.state={failed:false}}`
    + `static getDerivedStateFromError(){return{failed:true}}componentDidCatch(error){globalThis.__vscodexLayerBridge?.threadMenuError(error.message,this.props.token)}`
    + `render(){return this.state.failed?null:this.props.children}};`
    + `return __vclDom().createPortal(J.jsx(__vclMenuBoundary,{token:target.token,children:J.jsx(__vclMenu,{__vclLayerMenu:true,__vclMenuToken:target.token,conversationId:target.thread.id,hostId:target.thread.hostId,`
    + `cwd:target.thread.cwd,title:target.thread.title,canPin:false,archiveNavigation:"stay",archiveSource:"vscodex_layer",`
    + `triggerButtonClassName:"vcl-native-menu-trigger"},target.thread.id)},target.token),target.container);}`
    + `function __vclArchiveActions(){__vclArchiveInit();__vclMenuInit();let R=__vclReact(),scope=__vclArchiveScope(__vclArchiveScopeAtom),surface=R.useRef({}).current;`
    + `R.useEffect(()=>globalThis.__vscodexLayerBridge?.registerArchiveActions(surface,{archive:async target=>{`
    + `let service=__vclArchiveService(scope,"local"),busy=()=>scope.get(__vclArchiveActive,target.id)?.type==="active"`
    + `||scope.get(__vclArchiveRestricted,{hostId:"local",threadId:target.id});`
    + `if(busy())return{skipped:true};`
    + `let tasks=await __vclArchiveAutomations(${menu.batch.automationCommand ? '"list-automations"' : ''});`
    + `if(__vclArchiveMatchAutomation({automations:tasks.items,conversationId:target.id,includePausedAutomations:true}))return{skipped:true};`
    + `await service.hydrateBackgroundThreads([target.id]);`
    + `if(!service.getConversation(target.id))throw new Error("未能加载聊天，未执行归档。");`
    + `let result=await service.readThread(target.id,{includeTurns:false});`
    + `if(result.thread?.id!==target.id)throw new Error("聊天信息不一致，未执行归档。");`
    + `if(busy()||["active","running"].includes(result.thread.status?.type))return{skipped:true};`
    + `await service.archiveConversation(target.id,{useAppServerPins:scope.get(__vclArchivePins),cleanupWorktree:false,source:"vscodex_layer_batch"});`
    + `globalThis.__vscodexLayerBridge?.threadArchived(target.id);`
    + `scope.queryClient.invalidateQueries({queryKey:["archived-threads"]}).catch(()=>{});return{archived:true};`
    + `},restore:async target=>{`
    + `try{await __vclArchiveService(scope,"local").unarchiveConversation(target.id,{useAppServerPins:scope.get(__vclArchivePins)})}`
    + `catch(error){if(!(${archive.openErrorKind === 'predicate' ? '__vclArchiveOpenError(error)' : 'error instanceof __vclArchiveOpenError'}))throw error;return{restored:true,openable:false}}`
    + `finally{scope.queryClient.invalidateQueries({queryKey:["archived-threads"]}).catch(()=>{})}`
    + `return{restored:true,openable:true}}}),[scope,surface]);return null}`
    + `function __vclHeader(props){let J=__vclJsx();return J.jsxs(J.Fragment,{children:[J.jsx(${exported},props),J.jsx(__vclMenuPortal,{}),J.jsx(__vclArchiveActions,{})]});}`;
  return imports + source.replace(`${exported} as t`, '__vclHeader as t') + '\n' + wrapper;
}

// Check the bridge's added imports against the actual native export tables.
// Syntax-only checks and component mocks cannot catch missing named exports.
export async function validateHeaderImports(source, readModule) {
  const modules = new Map();
  for (const match of source.matchAll(/import\{([^}]+)\}from["']([^"']+)["']/g)) {
    const bindings = match[1].split(',').map((binding) => binding.trim().split(/\s+as\s+/))
      .filter((binding) => binding[1]?.startsWith('__vcl'));
    if (!bindings.length) continue;
    if (!modules.has(match[2])) {
      const dependency = await readModule(match[2]);
      const names = new Set([...dependency.matchAll(/export\{([^}]+)\}/g)].flatMap((exports) =>
        exports[1].split(',').map((binding) => binding.trim().split(/\s+as\s+/).at(-1))));
      modules.set(match[2], names);
    }
    for (const [name] of bindings) {
      if (!modules.get(match[2]).has(name)) throw new Error(`原生菜单依赖缺少导出：${match[2]} → ${name}`);
    }
  }
}

export function portalDependency(source) {
  const portal = /([A-Za-z_$][\w$]*)\.createPortal\(/.exec(source)?.[1];
  if (portal) return exportName(source, unique([...source.matchAll(new RegExp(`${escape(portal)}=${identifier}\\((${identifier})\\(\\),1\\)`, 'g'))], 'React DOM 依赖')[1]);
  // New bundles export the CommonJS loader without calling createPortal here.
  const definitions = [...source.matchAll(/\.createPortal=function\(/g)];
  const definition = unique(definitions, 'React Portal 实现');
  const loaders = [...source.slice(0, definition.index).matchAll(new RegExp(`(?:var |,)(${identifier})=${identifier}\\(\\(${identifier}=>\\{`, 'g'))];
  const native = loaders.at(-1)?.[1];
  if (!native) throw new Error('无法识别原生 React Portal 加载器。');
  const publicLoader = unique([...source.matchAll(new RegExp(`(${identifier})=${identifier}\\(\\(\\(${identifier},${identifier}\\)=>\\{[\\s\\S]{0,500}?\\.exports=${escape(native)}\\(\\)\\}\\)\\)`, 'g'))], 'React DOM 公共加载器')[1];
  return exportName(source, publicLoader);
}

export async function buildChatMenuPatch(root, header) {
  const directory = path.join(root, 'webview', 'assets');
  const entries = await fs.readdir(directory);
  const candidates = await Promise.all(entries.filter((name) => name.startsWith('thread-overflow-menu-') && name.endsWith('.js'))
    .map(async (name) => {
      const relative = `webview/assets/${name}`;
      return { path: relative, bytes: await readUnpatched(root, relative) };
    }));
  const selected = unique(candidates.filter(({ bytes }) => bytes.toString().includes('archiveNavigation:')), '聊天菜单资源');
  const menu = patchThreadMenu(selected.bytes.toString());
  menu.componentExport = exportName(selected.bytes.toString(), menu.component);
  const frameworkPath = path.posix.join('webview/assets', menu.react.file);
  const framework = (await readUnpatched(root, frameworkPath)).toString();
  const dom = { file: menu.react.file, exported: portalDependency(framework) };
  const archiveCandidates = await Promise.all(entries.filter((name) => name.startsWith('local-preview-footer-') && name.endsWith('.js'))
    .map(async (name) => {
      const relative = `webview/assets/${name}`;
      return { path: relative, content: (await readUnpatched(root, relative)).toString() };
    }));
  const archiveSource = unique(archiveCandidates.filter(({ content }) => content.includes('previewUnarchiveError')), '原生归档恢复资源');
  const archive = { path: archiveSource.path, ...archiveDependencies(archiveSource.content) };
  const patchedHeader = patchMenuHeader(header, { menuPath: selected.path, menu, dom, archive });
  await validateHeaderImports(patchedHeader, async (file) =>
    (await readUnpatched(root, path.posix.join('webview/assets', file))).toString());
  return { header: patchedHeader,
    file: { path: selected.path, originalHash: sha256(selected.bytes), content: menu.content },
    compatibility: { menu: selected.path, component: menu.component, framework: frameworkPath, archive } };
}
