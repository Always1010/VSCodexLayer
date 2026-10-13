import fs from 'node:fs/promises';
import path from 'node:path';
import { readUnpatched } from '../lib/patch-engine.mjs';
import { validateHeaderImports } from './chat-menu.mjs';

const identifier = String.raw`[A-Za-z_$][\w$]*`;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function unique(matches, label) {
  if (matches.length !== 1) throw new Error(`${label}接入点数量异常：${matches.length}`);
  return matches[0];
}
function exported(source, local) {
  return unique([...source.matchAll(new RegExp(`\\b${escape(local)} as (${identifier})(?=[,}])`, 'g'))], '子聊天依赖导出')[1];
}

export function patchAgentDetailHeader(header, { file, component, initializer }) {
  const wrapper = unique([...header.matchAll(/\b(__vclHeader) as t(?=[,}])/g)], '增强聊天标题')[1];
  const imports = `import{${component} as __vclAgentThread,${initializer} as __vclAgentThreadInit}from"./${path.posix.basename(file)}";`;
  const code = `let __vclAgentBoundary;function __vclAgentPortal(){__vclArchiveInit();let R=__vclReact(),J=__vclJsx(),bridge=globalThis.__vscodexLayerBridge,`
    + `scope=__vclArchiveScope(__vclArchiveScopeAtom),surface=R.useRef({}).current;`
    + `R.useEffect(()=>bridge?.registerAgentDetailSurface(surface,{prepare:async(rootId,threadId)=>{`
    + `await __vclArchiveService(scope,"local").hydrateBackgroundThreads([rootId,threadId],{includeTurns:true,refreshExisting:true})}}),[bridge,scope,surface]);`
    + `let target=R.useSyncExternalStore(bridge?.subscribeAgentDetail??__vclMenuNoop,bridge?.agentDetailTarget??__vclMenuOff,__vclMenuOff);`
    + `if(!target||target.surface!==surface||target.loading||!target.container.isConnected)return null;__vclAgentThreadInit();`
    + `if(!__vclAgentBoundary)__vclAgentBoundary=class extends R.Component{constructor(p){super(p);this.state={failed:false}}`
    + `static getDerivedStateFromError(){return{failed:true}}componentDidCatch(error){globalThis.__vscodexLayerBridge?.agentDetailError(error.message,this.props.token)}`
    + `render(){return this.state.failed?null:this.props.children}};`
    + `return __vclDom().createPortal(J.jsx(__vclAgentBoundary,{token:target.token,children:J.jsx(__vclAgentThread,{`
    + `canInteract:false,shouldResume:false,conversationId:target.threadId,hostId:"local",`
    + `onOpenBackgroundAgent:agent=>bridge?.selectAgentDetail(agent.conversationId)},target.threadId)},target.token),target.container);}`
    + `function __vclAgentHeader(props){let J=__vclJsx();return J.jsxs(J.Fragment,{children:[J.jsx(${wrapper},props),J.jsx(__vclAgentPortal,{})]});}`;
  return imports + header.replace(`${wrapper} as t`, '__vclAgentHeader as t') + '\n' + code;
}

export async function buildAgentDetailHeader(root, header) {
  const entries = await fs.readdir(path.join(root, 'webview', 'assets'));
  const candidates = [];
  for (const name of entries.filter((name) => /^local-conversation-thread-.*\.js$/.test(name))) {
    const file = `webview/assets/${name}`, source = (await readUnpatched(root, file)).toString();
    const signatures = [...source.matchAll(new RegExp(`function (${identifier})\\((${identifier})\\)\\{let ${identifier}=\\(0,(${identifier})\\.c\\)\\(\\d+\\),\\{canInteract:`, 'g'))];
    if (signatures.length) candidates.push({ file, source, signatures });
  }
  // Native detail is optional. A missing component preserves the overview and
  // official full-thread navigation instead of breaking installation.
  if (!candidates.length) return { header, compatibility: { supported: false, reason: '插件不包含可复用的只读子聊天组件' } };
  const { file, source, signatures } = unique(candidates, '原生子聊天模块');
  const match = unique(signatures, '原生只读子聊天组件');
  const initializer = unique([...source.matchAll(new RegExp(`function (${identifier})\\(\\)\\{return\\(\\1=${identifier}\\(\\(\\(\\)=>\\{${escape(match[3])}=`, 'g'))], '原生子聊天初始化')[1];
  const detail = { file, component: exported(source, match[1]), initializer: exported(source, initializer) };
  const patched = patchAgentDetailHeader(header, detail);
  await validateHeaderImports(patched, async (file) => (await readUnpatched(root, path.posix.join('webview/assets', file))).toString());
  return { header: patched, compatibility: { supported: true, ...detail } };
}
