import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extensionRoot, readOriginal } from '../lib/patch-engine.mjs';
import { patchProjectCreationMembership } from './codex-compatible.mjs';

export const VERSION = '26.5930.51102';
export const ADAPTER = `codex-${VERSION}-v4`;
export const DRAFT_SOURCE = ['webview/assets/app-initial-50ebc5be4f47.js',
  '9b78830beea2d5af1e0a0f3073c7d8854e802ed0044673f5bfdde9230a44b254'];
const ORIGINALS = [
  ['out/extension.js', '1f051b97e1388816133ba9a5070832bf77ccd3e47b47fbda88f7a3d0be809e40'],
  ['webview/index.html', '27936dc2b6826728ba4e65a129f4603d2137102a37ba61417f2a7cf106d1b4a1'],
  ['webview/assets/app-initial-3a0869cff48f.js', '1db99374c9fecea31a0c54cf5fffa6c996346b15bc712085b44981526d698316'],
  ['webview/assets/header-2cbf162f197f.js', 'd622238e6957ebca2ec8356f5570c1a1d1851c8ee7b43dae41ecea1d254bd507'],
  DRAFT_SOURCE,
];

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error(`官方接入点数量异常：${anchor.slice(0, 80)}`);
  return source.replace(anchor, replacement);
}

export async function buildPatchPlan(directory) {
  const { version } = await extensionRoot(directory);
  if (version !== VERSION) throw new Error(`当前仅适配 Codex ${VERSION}，检测到 ${version}。`);
  const originals = await Promise.all(ORIGINALS.map(async ([relative, hash]) => ({
    path: relative, originalHash: hash, content: (await readOriginal(directory, relative, hash)).toString('utf8'),
  })));
  const anchor = 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),';
  originals[0].content = replaceOnce(originals[0].content, anchor,
    'let __vclHost;try{__vclHost=require(Ge.Uri.joinPath(this.extensionUri,"out","vscodex-layer-host.cjs").fsPath)'
    + '.createLayerHost({vscode:Ge,provider:this,webview:e,onDispose:n,isWsl:()=>Wr()});'
    + 'this.subscriptions.push(__vclHost)}catch(__vclError){this.logger.warning("VSCodexLayer host unavailable")}'
    + 'let a=e.onDidReceiveMessage(u=>{if(__vclHost?.handle(u))return;if(s.markMessageReceived(),');
  const script = '<script type="module" crossorigin src="./assets/index-625cd12fbdb9.js">';
  originals[1].content = replaceOnce(originals[1].content, script,
    '<!-- VSCodexLayer v1 -->\n'
    + '    <link rel="stylesheet" href="./vscodex-layer/layer.css" />\n'
    + '    <script src="./vscodex-layer/bootstrap.js"></script>\n'
    + '    <script type="module" src="./vscodex-layer/layer.mjs"></script>\n    ' + script);
  const routeAnchor = 'Tm(`navigate-to-route`,D);let O;';
  originals[2].content = replaceOnce(originals[2].content, routeAnchor,
    'globalThis.__vscodexLayerBridge?.observeRoute(r.pathname+r.search);' + routeAnchor);
  // Keep the home/panel draft identity and skip the native fresh-composer reset only for plain new-chat actions.
  originals[2].content = replaceOnce(originals[2].content, 'function KV(e,t){',
    'function KV(e,t){if(globalThis.__vscodexLayerBridge?.resumeDraft(t))return;');
  // The query carries the selected directory through the native route and composer scopes.
  originals[2].content = replaceOnce(originals[2].content,
    'function Wv({pathname:e,routeTemplate:t,search:n=``}){',
    'function Wv({pathname:e,routeTemplate:t,search:n=``}){'
    + 'let __vclRoute=globalThis.__vscodexLayerBridge?.projectRoute(e,t,n);if(__vclRoute)return __vclRoute;');
  for (const name of ['Dv', 'Uv']) {
    const anchor = `function ${name}(e){switch(e.routeKind){`;
    originals[2].content = replaceOnce(originals[2].content, anchor,
      `function ${name}(e){if(e.vclDraftKey!=null)return e.vclDraftKey;switch(e.routeKind){`);
  }
  for (const name of ['ey', '_nt', 'gnt']) {
    const anchor = `function ${name}(e){`;
    originals[2].content = replaceOnce(originals[2].content, anchor,
      anchor + 'if(e.kind===`new`&&e.vclDraftKey!=null)return e.vclDraftKey;');
  }
  originals[2].content = replaceOnce(originals[2].content,
    'function xnt(e,t,n){let r=Hv(e);',
    'function xnt(e,t,n){if(e.vclDraftKey!=null)return{kind:`new`,entrypoint:e.routeKind===`home`?`home`:`panel`,'
    + 'browserTabMentionConversationId:n??null,routeConversationId:null,vclDraftKey:e.vclDraftKey,vclProjectCwd:e.vclProjectCwd};let r=Hv(e);');
  originals[2].content = replaceOnce(originals[2].content,
    'if(ZBe(e))return t(Iv,e);', 'if(ZBe(e)||e.startsWith(`vscodex-layer-new:`))return t(Iv,e);');
  // Native draft storage is retained; only project-scoped new composers override directory selection.
  originals[4].content = replaceOnce(originals[4].content,
    'Iua=Jo(lg,(e,{get:t,scope:n})=>{',
    'Iua=Jo(lg,(e,{get:t,scope:n})=>{let __vclCwd=globalThis.__vscodexLayerBridge?.projectCwd(n.value);'
    + 'if(__vclCwd!==undefined)return{target:{activeWorkspaceRoot:__vclCwd,cwd:__vclCwd,hostConfig:t(hh,`local`),'
    + 'hostId:`local`,isActiveWorkspaceRootLoading:!1},selectedRemoteProject:null,selectedRemoteProjectId:null,'
    + 'executionRemoteHostId:null,resolvedCwd:__vclCwd,projectLoading:!1,remoteWorkspaceRoots:undefined,'
    + 'projectKey:q6n({cwd:__vclCwd,hostId:`local`,isFollowUp:!1,isLoading:!1})};');
  originals[4].content = replaceOnce(originals[4].content,
    'Lua=Jo(lg,({selectedProject:e,useScopedProject:t},{get:n,scope:r})=>{',
    'Lua=Jo(lg,({selectedProject:e,useScopedProject:t},{get:n,scope:r})=>{'
    + 'let __vclCwd=globalThis.__vscodexLayerBridge?.projectCwd(r.value);'
    + 'if(__vclCwd!==undefined)return{activeLocalProjectCwd:__vclCwd,activeWorkspaceRootPaths:[__vclCwd],'
    + 'projectRootPaths:[__vclCwd],threadProjectAssignment:undefined,workspaceBrowserRoot:__vclCwd,workspaceRootsLoading:!1};');
  // Project buttons start local chats in the named directory, including when a prior draft used worktree/cloud.
  originals[4].content = replaceOnce(originals[4].content,
    'yua=Jo(lg,({authMethod:e,target:t,isRemoteProject:n,isResponseInProgress:r},{get:i,scope:a})=>{',
    'yua=Jo(lg,({authMethod:e,target:t,isRemoteProject:n,isResponseInProgress:r},{get:i,scope:a})=>{'
    + 'if(globalThis.__vscodexLayerBridge?.projectCwd(a.value)!==undefined)return Gxr;');
  originals[4].content = replaceOnce(originals[4].content,
    'bua=Jo(lg,({hostId:e,projectKey:t,prefillKey:n,availability:r},{get:i,scope:a})=>{',
    'bua=Jo(lg,({hostId:e,projectKey:t,prefillKey:n,availability:r},{get:i,scope:a})=>{'
    + 'if(globalThis.__vscodexLayerBridge?.projectCwd(a.value)!==undefined)return{preferredMode:`local`,effectiveMode:`local`};');
  originals[4].content = replaceOnce(originals[4].content,
    'tt=Vd(),{state:nt}=tt,rt=',
    'tt=Vd(),{state:nt}=tt,__vclProjectCwd=globalThis.__vscodexLayerBridge?.projectCwd(be.value),rt=');
  originals[4].content = replaceOnce(originals[4].content,
    'cwdOverride:Li}=Eda(', 'cwdOverride:__vclPermissionCwd}=Eda(');
  originals[4].content = replaceOnce(originals[4].content,
    'currentRemoteCwd:ur?ut:Kr}),Ri=',
    'currentRemoteCwd:ur?ut:Kr}),Li=__vclProjectCwd??__vclPermissionCwd,Ri=');
  originals[4].content = replaceOnce(originals[4].content,
    'submitDisabled:vs,workspaceRootsForLocalExecution:ho',
    'submitDisabled:vs||__vclProjectCwd!==undefined,workspaceRootsForLocalExecution:ho');
  originals[4].content = replaceOnce(originals[4].content,
    'existingWorkspaceRoot:at,localProjectId:rt,remoteProjectId:Gr?.id,workspaceRoots:mo',
    'existingWorkspaceRoot:__vclProjectCwd??at,localProjectId:__vclProjectCwd!==undefined?undefined:rt,'
    + 'remoteProjectId:__vclProjectCwd!==undefined?undefined:Gr?.id,workspaceRoots:mo');
  originals[4].content = replaceOnce(originals[4].content,
    'c={...ks,...s,attachmentOrder:', 'c={...ks,...s,vclProjectCwd:__vclProjectCwd,attachmentOrder:');
  // Validate again immediately before the native creation path. A failed check never falls back to the workspace.
  originals[4].content = replaceOnce(originals[4].content,
    'R=async(n,r,i,a,s,c,u)=>{let f=e.get(pC)',
    'R=async(n,r,i,a,s,c,u)=>{if(n.vclProjectCwd!==undefined){'
    + 'let __vclProject=await globalThis.__vscodexLayerBridge.validateProject(n.vclProjectCwd);'
    + 'if(!d())throw new DOMException(`Composer was closed`,`AbortError`);'
    + 'n={...n,existingWorkspaceRoot:__vclProject.cwd,workspaceRoots:[__vclProject.cwd],localProjectId:undefined,'
    + 'remoteProjectId:undefined,cloudThreadPrototype:undefined,aeonStartTarget:undefined};'
    + 'a={...a,hostId:`local`,workspaceRoots:[__vclProject.cwd]};r=__vclProject.cwd;}'
    + 'let f=e.get(pC)');
  originals[4].content = patchProjectCreationMembership(originals[4].content);
  const history = 'm&&(0,$.jsx)(`div`,{children:(0,$.jsx)(Et,{tasksQuery:b,mergedTasks:S})})';
  originals[3].content = replaceOnce(originals[3].content, history,
    'm&&(0,$.jsx)(`div`,{"data-vcl-home-history":true,children:(0,$.jsx)(Et,{tasksQuery:b,mergedTasks:S})})');
  const title = '(0,$.jsx)(g,{id:`header.recentChats`,defaultMessage:`Chats`,description:`Header label for recent tasks`})';
  originals[3].content = replaceOnce(originals[3].content, title,
    '(0,$.jsx)(`span`,{"data-vcl-home-history":true,children:' + title + '})');
  originals[3].content = replaceOnce(originals[3].content,
    'onClick:n,"aria-label":a,children:o',
    'onClick:n,"aria-label":a,"data-vcl-chat-back":true,children:o');
  const assets = [
    ['runtime/host.cjs', 'out/vscodex-layer-host.cjs'],
    ['webview/bootstrap.js', 'webview/vscodex-layer/bootstrap.js'],
    ['webview/client.mjs', 'webview/vscodex-layer/client.mjs'],
    ['webview/core.mjs', 'webview/vscodex-layer/core.mjs'],
    ['webview/layer.mjs', 'webview/vscodex-layer/layer.mjs'],
    ['webview/layer.css', 'webview/vscodex-layer/layer.css'],
  ];
  for (const [source, target] of assets) {
    originals.push({ path: target, originalHash: null,
      content: await fs.readFile(fileURLToPath(new URL(`../${source}`, import.meta.url))) });
  }
  return { adapter: ADAPTER, extensionVersion: VERSION, files: originals };
}
