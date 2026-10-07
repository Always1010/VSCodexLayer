import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extensionRoot, readUnpatched, sha256 } from '../lib/patch-engine.mjs';

export const FAMILY = 'codex-webview-family-1';
const identifier = String.raw`[A-Za-z_$][\w$]*`;

function replaceUnique(source, pattern, replacement, label) {
  const matches = [...source.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`${label}接入点数量异常：${matches.length}`);
  return source.replace(pattern, replacement);
}

function insertAt(source, index, text) {
  return `${source.slice(0, index)}${text}${source.slice(index)}`;
}

async function originalsIn(directory, prefix) {
  const { root } = await extensionRoot(directory);
  const assetDirectory = path.join(root, 'webview', 'assets');
  const entries = await fs.readdir(assetDirectory, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.js'))
    .map(async (entry) => {
      const relative = `webview/assets/${entry.name}`;
      return { path: relative, bytes: await readUnpatched(root, relative) };
    }));
}

function choose(files, predicate, label) {
  const matches = files.filter(({ bytes }) => predicate(bytes.toString('utf8')));
  if (matches.length !== 1) throw new Error(`${label}候选文件数量异常：${matches.length}`);
  return matches[0];
}

function patchHost(source) {
  const anchor = 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),';
  const anchorMatches = [...source.matchAll(new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))];
  if (anchorMatches.length !== 1) throw new Error(`宿主消息桥接入点数量异常：${anchorMatches.length}`);
  const prefix = source.slice(Math.max(0, anchorMatches[0].index - 5000), anchorMatches[0].index);
  const namespaceMatches = [...prefix.matchAll(new RegExp(`let ${identifier}=(${identifier})\\.Uri\\.joinPath\\(this\\.extensionUri,"webview"\\)`, 'g'))];
  if (namespaceMatches.length !== 1) throw new Error(`VS Code API 命名空间数量异常：${namespaceMatches.length}`);
  const vscode = namespaceMatches[0][1];
  return replaceUnique(source, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    `let __vclHost;try{__vclHost=require(${vscode}.Uri.joinPath(this.extensionUri,"out","vscodex-layer-host.cjs").fsPath)`
    + `.createLayerHost({vscode:${vscode},provider:this,webview:e,onDispose:n,isWsl:()=>${vscode}.env.remoteName==="wsl"});`
    + 'this.subscriptions.push(__vclHost)}catch(__vclError){this.logger.warning("VSCodexLayer host unavailable: "+String(__vclError?.stack??__vclError))}'
    + 'let a=e.onDidReceiveMessage(u=>{if(__vclHost?.handle(u))return;if(s.markMessageReceived(),', '宿主消息桥');
}

function patchHtml(source) {
  return replaceUnique(source, /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']+["'][^>]*><\/script>/i,
    '<!-- VSCodexLayer v1 -->\n    <link rel="stylesheet" href="./vscodex-layer/layer.css" />\n'
    + '    <script src="./vscodex-layer/bootstrap.js"></script>\n'
    + '    <script type="module" src="./vscodex-layer/layer.mjs"></script>\n    $&', '页面模块');
}

function patchRoute(source) {
  const routeHook = new RegExp(`(${identifier})\\(\`navigate-to-route\`,(${identifier})\\);let (${identifier});`);
  const match = [...source.matchAll(new RegExp(routeHook.source, 'g'))];
  if (match.length !== 1) throw new Error(`路由观察接入点数量异常：${match.length}`);
  const tail = source.slice(match[0].index + match[0][0].length, match[0].index + match[0][0].length + 260);
  const routeVariable = new RegExp(`!==(${identifier})\\.pathname`).exec(tail)?.[1];
  if (!routeVariable) throw new Error('无法识别当前路由变量。');
  source = insertAt(source, match[0].index,
    `globalThis.__vscodexLayerBridge?.observeRoute(${routeVariable}.pathname+${routeVariable}.search);`);

  source = replaceUnique(source,
    new RegExp(`function (${identifier})\\((${identifier}),(${identifier})\\)\\{(?=let\\{activeProject:)`),
    (_all, name, scope, options) => `function ${name}(${scope},${options}){if(globalThis.__vscodexLayerBridge?.resumeDraft(${options}))return;`,
    '原生新聊天');
  source = replaceUnique(source,
    new RegExp(`function (${identifier})\\(\\{pathname:(${identifier}),routeTemplate:(${identifier}),search:(${identifier})=\`\`\\}\\)\\{`),
    (_all, name, pathname, template, search) => `function ${name}({pathname:${pathname},routeTemplate:${template},search:${search}=\`\`}){`
      + `let __vclRoute=globalThis.__vscodexLayerBridge?.projectRoute(${pathname},${template},${search});if(__vclRoute)return __vclRoute;`,
    '项目路由');

  const routeKey = new RegExp(`function (${identifier})\\((${identifier})\\)\\{(?=switch\\(\\2\\.routeKind\\)\\{case\`home\`:return ${identifier}\\(\\{entrypoint:\`home\`\\}\\);case\`new-thread-panel\`)`, 'g');
  const routeKeyMatches = [...source.matchAll(routeKey)];
  if (routeKeyMatches.length !== 2) throw new Error(`路由草稿键接入点数量异常：${routeKeyMatches.length}`);
  source = source.replace(routeKey, (_all, name, value) =>
    `function ${name}(${value}){if(${value}.vclDraftKey!=null)return ${value}.vclDraftKey;`);

  const valueKey = new RegExp(`function (${identifier})\\((${identifier})\\)\\{(?=(?:switch\\(\\2\\.kind\\)\\{case\`new\`|if\\(\\2\\.kind!==\`new\`\\)))`, 'g');
  const valueKeyMatches = [...source.matchAll(valueKey)];
  if (valueKeyMatches.length !== 3) throw new Error(`聊天草稿键接入点数量异常：${valueKeyMatches.length}`);
  source = source.replace(valueKey, (_all, name, value) =>
    `function ${name}(${value}){if(${value}.kind===\`new\`&&${value}.vclDraftKey!=null)return ${value}.vclDraftKey;`);

  source = replaceUnique(source,
    new RegExp(`function (${identifier})\\((${identifier}),(${identifier}),(${identifier})\\)\\{let (${identifier})=(${identifier})\\(\\2\\);switch\\(\\2\\.routeKind\\)\\{`),
    (_all, name, route, options, mention, conversation, helper) =>
      `function ${name}(${route},${options},${mention}){if(${route}.vclDraftKey!=null)return{kind:\`new\`,entrypoint:${route}.routeKind===\`home\`?\`home\`:\`panel\`,`
      + `browserTabMentionConversationId:${mention}??null,routeConversationId:null,vclDraftKey:${route}.vclDraftKey,vclProjectCwd:${route}.vclProjectCwd};`
      + `let ${conversation}=${helper}(${route});switch(${route}.routeKind){`, '路由上下文');

  source = replaceUnique(source,
    new RegExp(`if\\((${identifier})\\((${identifier})\\)\\)return \\2;if\\((${identifier})\\(\\2\\)\\)return (${identifier})\\((${identifier}),\\2\\);let`),
    (_all, isClient, value, isDraft, getter, atom) =>
      `if(${isClient}(${value}))return ${value};if(${isDraft}(${value})||${value}.startsWith(\`vscodex-layer-new:\`))return ${getter}(${atom},${value});let`,
    '草稿客户标识');
  return source;
}

function arrowBody(source, marker, label) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`${label}接入点缺失。`);
  const start = source.lastIndexOf('=>{', markerIndex);
  const end = source.indexOf('},{isEqual:', markerIndex);
  if (start < 0 || end < 0) throw new Error(`${label}函数边界异常。`);
  return { start: start + 3, end, body: source.slice(start + 3, end) };
}

function patchComposer(source) {
  let part = arrowBody(source, 'useScopedProject&&', '项目目标');
  const signature = new RegExp(`\\((${identifier}),\\{get:(${identifier}),scope:(${identifier})\\}\\)=>\\{$`)
    .exec(source.slice(Math.max(0, part.start - 120), part.start));
  const hostAtom = /hostConfig:[A-Za-z_$][\w$]*\(([A-Za-z_$][\w$]*),/.exec(part.body)?.[1];
  const projectKey = /projectKey:([A-Za-z_$][\w$]*)\(\{/.exec(part.body)?.[1];
  if (!signature || !hostAtom || !projectKey) throw new Error('无法识别项目目标局部变量。');
  const [, options, get, scope] = signature;
  source = insertAt(source, part.start,
    `let __vclCwd=globalThis.__vscodexLayerBridge?.projectCwd(${scope}.value);if(__vclCwd!==undefined)return{target:{activeWorkspaceRoot:__vclCwd,cwd:__vclCwd,hostConfig:${get}(${hostAtom},\`local\`),hostId:\`local\`,isActiveWorkspaceRootLoading:!1},selectedRemoteProject:null,selectedRemoteProjectId:null,executionRemoteHostId:null,resolvedCwd:__vclCwd,projectLoading:!1,remoteWorkspaceRoots:undefined,projectKey:${projectKey}({cwd:__vclCwd,hostId:\`local\`,isFollowUp:!1,isLoading:!1})};`);

  part = arrowBody(source, 'activeLocalProjectCwd:', '项目根目录');
  const rootsSignature = new RegExp(`\\(\\{selectedProject:(${identifier}),useScopedProject:(${identifier})\\},\\{get:(${identifier}),scope:(${identifier})\\}\\)=>\\{$`)
    .exec(source.slice(Math.max(0, part.start - 150), part.start));
  if (!rootsSignature) throw new Error('无法识别项目根目录局部变量。');
  const [, , , , rootsScope] = rootsSignature;
  source = insertAt(source, part.start,
    `let __vclCwd=globalThis.__vscodexLayerBridge?.projectCwd(${rootsScope}.value);if(__vclCwd!==undefined)return{activeLocalProjectCwd:__vclCwd,activeWorkspaceRootPaths:[__vclCwd],projectRootPaths:[__vclCwd],threadProjectAssignment:undefined,workspaceBrowserRoot:__vclCwd,workspaceRootsLoading:!1};`);

  source = replaceUnique(source,
    new RegExp(`(\\(\\{authMethod:${identifier},target:${identifier},isRemoteProject:${identifier},isResponseInProgress:${identifier}\\},\\{get:${identifier},scope:(${identifier})\\}\\)=>\\{)`),
    (_all, head, scopeValue) => `${head}if(globalThis.__vscodexLayerBridge?.projectCwd(${scopeValue}.value)!==undefined)return{isLocalAvailable:!0,isWorktreeAvailable:!1,cloudUnavailableReason:\`context\`};`,
    '运行模式可用性');

  source = replaceUnique(source,
    new RegExp(`(\\(\\{hostId:${identifier},projectKey:${identifier},prefillKey:${identifier},availability:${identifier}\\},\\{get:${identifier},scope:(${identifier})\\}\\)=>\\{)`),
    (_all, head, scopeValue) => `${head}if(globalThis.__vscodexLayerBridge?.projectCwd(${scopeValue}.value)!==undefined)return{preferredMode:\`local\`,effectiveMode:\`local\`};`,
    '运行模式选择');

  const statePattern = new RegExp(`(${identifier})=(${identifier})\\(\\),\\{state:(${identifier})\\}=\\1,(${identifier})=`);
  const stateMatches = [...source.matchAll(new RegExp(statePattern.source, 'g'))];
  if (stateMatches.length !== 1) throw new Error(`Composer 项目状态接入点数量异常：${stateMatches.length}`);
  const stateIndex = stateMatches[0].index;
  const scopeValue = [...source.slice(Math.max(0, stateIndex - 3000), stateIndex)
    .matchAll(new RegExp(`(${identifier})\\.value\\.kind===\`local\``, 'g'))].at(-1)?.[1];
  if (!scopeValue) throw new Error('无法识别 Composer 作用域变量。');
  source = replaceUnique(source, statePattern,
    (_all, stateObject, stateFunction, state, next) =>
      `${stateObject}=${stateFunction}(),{state:${state}}=${stateObject},__vclProjectCwd=globalThis.__vscodexLayerBridge?.projectCwd(${scopeValue}.value),${next}=`,
    'Composer 项目状态');

  let cwdVariable;
  source = replaceUnique(source,
    new RegExp(`cwdOverride:(${identifier})\\}=(${identifier})\\(`),
    (_all, cwd, helper) => { cwdVariable = cwd; return `cwdOverride:__vclPermissionCwd}=${helper}(`; },
    'Composer 权限目录');
  source = replaceUnique(source,
    new RegExp(`(currentRemoteCwd:[^}]+\\}\\)),(${identifier})=`),
    (_all, end, next) => `${end},${cwdVariable}=__vclProjectCwd??__vclPermissionCwd,${next}=`,
    'Composer 有效目录');
  source = replaceUnique(source,
    new RegExp(`submitDisabled:(${identifier}),workspaceRootsForLocalExecution:(${identifier})(?=\\}\\))`),
    (_all, disabled, roots) => `submitDisabled:${disabled}||__vclProjectCwd!==undefined,workspaceRootsForLocalExecution:${roots}`,
    'Composer 提交预检');
  source = replaceUnique(source,
    new RegExp(`existingWorkspaceRoot:(${identifier}),localProjectId:(${identifier}),remoteProjectId:(${identifier})\\?\\.id,workspaceRoots:(${identifier})`),
    (_all, workspace, localProject, remoteProject, roots) =>
      `existingWorkspaceRoot:__vclProjectCwd??${workspace},localProjectId:__vclProjectCwd!==undefined?undefined:${localProject},remoteProjectId:__vclProjectCwd!==undefined?undefined:${remoteProject}?.id,workspaceRoots:${roots}`,
    'Composer 创建上下文');
  source = replaceUnique(source,
    new RegExp(`(${identifier})=\\{\\.\\.\\.(${identifier}),\\.\\.\\.(${identifier}),attachmentOrder:`),
    (_all, context, base, extra) => `${context}={...${base},...${extra},vclProjectCwd:__vclProjectCwd,attachmentOrder:`,
    'Composer 草稿上下文');

  const submitMarker = 'startConversationWithPrimaryRuntimeForFirstTurn:';
  const markerIndex = source.indexOf(submitMarker);
  if (markerIndex < 0) throw new Error('首次提交接入点缺失。');
  const submitMatch = new RegExp(`=async\\((${identifier}),(${identifier}),(${identifier}),(${identifier}),(${identifier}),(${identifier}),(${identifier})\\)=>\\{`)
    .exec(source.slice(markerIndex, markerIndex + 5000));
  const mounted = new RegExp(`isMounted:(${identifier})`).exec(source.slice(Math.max(0, markerIndex - 1800), markerIndex))?.[1];
  if (!submitMatch || !mounted) throw new Error('无法识别首次提交局部变量。');
  const submitStart = markerIndex + submitMatch.index;
  const [submitHeader, context, cwd, , target] = submitMatch;
  const injection = `if(${context}.vclProjectCwd!==undefined){let __vclProject=await globalThis.__vscodexLayerBridge.validateProject(${context}.vclProjectCwd);if(!${mounted}())throw new DOMException(\`Composer was closed\`,\`AbortError\`);${context}={...${context},existingWorkspaceRoot:__vclProject.cwd,workspaceRoots:[__vclProject.cwd],localProjectId:undefined,remoteProjectId:undefined,cloudThreadPrototype:undefined,aeonStartTarget:undefined};${target}={...${target},hostId:\`local\`,workspaceRoots:[__vclProject.cwd]};${cwd}=__vclProject.cwd;}`;
  source = source.slice(0, submitStart) + submitHeader + injection + source.slice(submitStart + submitHeader.length);
  return source;
}

function patchHeader(source) {
  source = replaceUnique(source,
    new RegExp(`(${identifier})&&\\(0,(${identifier})\\.jsx\\)\\(\`div\`,\\{children:\\(0,\\2\\.jsx\\)\\((${identifier}),\\{tasksQuery:(${identifier}),mergedTasks:(${identifier})\\}\\)\\}\\)`),
    (_all, visible, jsx, component, query, tasks) =>
      `${visible}&&(0,${jsx}.jsx)(\`div\`,{"data-vcl-home-history":true,children:(0,${jsx}.jsx)(${component},{tasksQuery:${query},mergedTasks:${tasks}})})`,
    '首页历史');
  source = replaceUnique(source,
    new RegExp(`\\(0,(${identifier})\\.jsx\\)\\((${identifier}),\\{id:\`header\\.recentChats\`,defaultMessage:\`Chats\`,description:\`Header label for recent tasks\`\\}\\)`),
    (_all, jsx, message) =>
      `(0,${jsx}.jsx)(\`span\`,{"data-vcl-home-history":true,children:(0,${jsx}.jsx)(${message},{id:\`header.recentChats\`,defaultMessage:\`Chats\`,description:\`Header label for recent tasks\`})})`,
    '首页标题');
  source = replaceUnique(source,
    new RegExp(`onClick:(${identifier}),"aria-label":(${identifier}),children:(${identifier})`),
    (_all, click, label, child) => `onClick:${click},"aria-label":${label},"data-vcl-chat-back":true,children:${child}`,
    '聊天返回按钮');
  return source;
}

export async function buildCompatiblePatchPlan(directory) {
  const { root, version } = await extensionRoot(directory);
  const appFiles = await originalsIn(root, 'app-initial-');
  const headerFiles = await originalsIn(root, 'header-');
  const route = choose(appFiles, (source) => source.includes('/extension/panel/new')
    && source.includes('navigate-to-route') && (source.split('activeWorkspaceRoot').length - 1) <= 2, '路由模块');
  const composer = choose(appFiles, (source) => (source.split('activeWorkspaceRoot').length - 1) >= 3
    && source.includes('startConversationWithPrimaryRuntimeForFirstTurn'), 'Composer 模块');
  const header = choose(headerFiles, (source) => source.includes('header.recentChats') && source.includes('tasksQuery'), '首页模块');
  const official = [
    ['out/extension.js', patchHost],
    ['webview/index.html', patchHtml],
    [route.path, patchRoute],
    [header.path, patchHeader],
    [composer.path, patchComposer],
  ];
  const files = [];
  for (const [relative, transform] of official) {
    const bytes = await readUnpatched(root, relative);
    files.push({ path: relative, originalHash: sha256(bytes), content: transform(bytes.toString('utf8')) });
  }
  for (const [source, target] of [
    ['runtime/host.cjs', 'out/vscodex-layer-host.cjs'],
    ['webview/bootstrap.js', 'webview/vscodex-layer/bootstrap.js'],
    ['webview/client.mjs', 'webview/vscodex-layer/client.mjs'],
    ['webview/core.mjs', 'webview/vscodex-layer/core.mjs'],
    ['webview/layer.mjs', 'webview/vscodex-layer/layer.mjs'],
    ['webview/layer.css', 'webview/vscodex-layer/layer.css'],
  ]) files.push({ path: target, originalHash: null,
    content: await fs.readFile(fileURLToPath(new URL(`../${source}`, import.meta.url))) });
  return { adapter: `${FAMILY}:${version}`, extensionVersion: version, files,
    compatibility: { family: FAMILY, route: route.path, composer: composer.path, header: header.path } };
}
