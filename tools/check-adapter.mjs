import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Script, createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { findExtension } from './layer.mjs';
import { buildPatchPlan, DRAFT_SOURCE } from '../adapters/codex-26.5930.51102.mjs';
import { applyPatch, restorePatch, sha256, readOriginal } from '../lib/patch-engine.mjs';

// Only read the real installation. Exercise mutations in a newly created fixture.
const args = process.argv.slice(2);
if (args.length && (args[0] !== '--extension' || args.length !== 2)) throw new Error('用法：node tools/check-adapter.mjs [--extension 路径]');
const directory = args[1] ?? await findExtension();
const plan = await buildPatchPlan(directory);
new Script(plan.files.find((entry) => entry.path === 'out/extension.js').content);
// Exercise the exact supported native draft functions without importing the app or opening VS Code.
const composerSource = plan.files.find((entry) => entry.path === DRAFT_SOURCE[0]).content;
const routeSource = plan.files.find((entry) => entry.path === 'webview/assets/app-initial-3a0869cff48f.js').content;
const functionSource = (source, name) => {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf('}function ', start);
  if (start < 0 || end < 0) throw new Error(`官方草稿接入点缺失：${name}`);
  return source.slice(start, end + 1);
};
const storage = new Map();
const draftAtom = Symbol('native-draft');
const bridgeHarness = createContext({ document: { querySelector: () => null }, queueMicrotask, URLSearchParams,
  acquireVsCodeApi: () => ({ getState() {}, setState() {}, postMessage() {} }) });
runInContext(await fs.readFile(new URL('../webview/bootstrap.js', import.meta.url), 'utf8'), bridgeHarness);
const projectBridge = bridgeHarness.__vscodexLayerBridge;
const harness = createContext({
  globalThis: { __vscodexLayerBridge: { ...projectBridge, resumeDraft: () => true } },
  wd: ({ entrypoint }) => `native-new:${entrypoint}`, Sp: undefined,
  eG: (prompt) => typeof prompt === 'string' ? prompt : prompt?.text ?? '',
  crr: () => false, Rnr: () => {}, ug: (id) => `local:${id}`,
  cG: Symbol(), mG: draftAtom, ZU: Symbol(), Brr: Symbol(),
  Wnr: () => {}, fke: () => {}, WW: () => {},
  rG: { setDraft(_scope, keys, draft) { for (const key of keys) draft === undefined ? storage.delete(key) : storage.set(key, draft); } },
});
runInContext(['Wv', 'Dv', 'Uv', 'xnt', 'ey', '_nt', 'gnt'].map((name) => functionSource(routeSource, name)).join(';') + ';Sp=ey;' +
  ['irr', 'QW', 'arr', 'Gnr'].map((name) => functionSource(composerSource, name)).join(';') +
  ';' + functionSource(routeSource, 'KV'), harness);
const scope = (value) => ({ value, get: () => storage.get(harness.ey(value)), set() {} });
for (const entrypoint of ['home', 'panel']) {
  const value = { kind: 'new', entrypoint };
  const text = `未发送的中文草稿\n第二行 @文件 /命令 ${entrypoint}`;
  harness.irr(scope(value), text);
  const other = { kind: 'local', clientThreadId: 'local:existing', conversationId: 'existing' };
  harness.irr(scope(other), '历史聊天自己的草稿');
  // Plain new-chat takes the enhancement's route-only path, never the native composer-reset path.
  harness.KV(scope(other), { selectChat: true });
  assert.equal(scope(value).get(draftAtom).prompt, text);
  assert.equal(scope(other).get(draftAtom).prompt, '历史聊天自己的草稿');
  const rich = { text, document: { content: [{ type: 'fileMention', path: 'D:/文件.md' }] } };
  harness.irr(scope(value), rich);
  assert.equal(scope(value).get(draftAtom).prompt, rich, '结构化草稿必须保留原对象');
  harness.Gnr(scope(value));
  assert.equal(scope(value).get(draftAtom), undefined, '官方提交清理后不能复活已发送草稿');
  assert.equal(scope(other).get(draftAtom).prompt, '历史聊天自己的草稿');
}
// Exercise the patched native route, client identity and structured draft storage with same-name projects.
const projectScopes = ['D:/Current/Project', 'D:/Other/Project', 'D:/Worktrees/branch'].map((cwd) => {
  const route = harness.Wv({ pathname: '/', routeTemplate: '/', search: `?vclProjectCwd=${encodeURIComponent(cwd)}` });
  assert.equal(harness.Dv(route), route.vclDraftKey);
  assert.equal(harness.Uv(route), route.vclDraftKey);
  const value = harness.xnt(route, undefined, 'native-client-id');
  assert.equal(harness._nt(value), route.vclDraftKey);
  const rich = { text: `${cwd} 的草稿`, document: { content: [{ type: 'fileMention', path: `${cwd}/文件.md` }] } };
  harness.irr(scope(value), rich);
  return { cwd, value, rich };
});
assert.equal(new Set(projectScopes.map(({ value }) => harness.ey(value))).size, 3);
for (const { value, rich } of projectScopes) assert.equal(scope(value).get(draftAtom).prompt, rich);
harness.Gnr(scope(projectScopes[1].value));
assert.equal(scope(projectScopes[1].value).get(draftAtom), undefined);
assert.equal(scope(projectScopes[0].value).get(draftAtom).prompt, projectScopes[0].rich);
const panelRoute = harness.Wv({ pathname: '/extension/panel/new', search: '?vclProjectCwd=D%3A%2FOther%2FProject' });
assert.notEqual(harness.ey(harness.xnt(panelRoute)), harness.ey(projectScopes[1].value));

const atomCallback = (source, name) => {
  const anchor = `${name}=Jo(lg,`;
  const start = source.indexOf(anchor) + anchor.length;
  const end = source.indexOf('},{isEqual:', start);
  if (start < anchor.length || end < start) throw new Error(`官方目录接入点缺失：${name}`);
  return source.slice(start, end + 1);
};
const nativeProject = createContext({ globalThis: harness.globalThis, hh: Symbol('host'),
  q6n: ({ cwd, hostId }) => `${hostId}:${cwd}`, Gxr: { isLocalAvailable: true, isWorktreeAvailable: false, cloudUnavailableReason: 'context' } });
runInContext(['Iua', 'Lua', 'yua', 'bua'].map((name) => `${name}=${atomCallback(composerSource, name)}`).join(';'), nativeProject);
for (const { cwd, value } of projectScopes) {
  const environment = { scope: { value }, get(atom, hostId) { assert.equal(atom, nativeProject.hh); assert.equal(hostId, 'local'); return { id: 'local' }; } };
  const target = nativeProject.Iua({ selectedProject: { type: 'local', projectId: 'wrong-project' } }, environment);
  assert.equal(target.resolvedCwd, cwd); assert.equal(target.target.cwd, cwd); assert.equal(target.target.hostId, 'local');
  const roots = nativeProject.Lua({}, environment);
  assert.equal(JSON.stringify(roots.projectRootPaths), JSON.stringify([cwd]));
  assert.equal(roots.workspaceBrowserRoot, cwd);
  assert.equal(nativeProject.yua({}, environment).isWorktreeAvailable, false);
  assert.equal(nativeProject.bua({}, environment).effectiveMode, 'local');
}
const clientIdentityStart = routeSource.indexOf('Lv=gr(Q,') + 'Lv=gr(Q,'.length;
const clientIdentityEnd = routeSource.indexOf('}),Rv=', clientIdentityStart);
runInContext(`clientIdentity=${routeSource.slice(clientIdentityStart, clientIdentityEnd + 1)}`, nativeProject);
nativeProject.Qu = () => false; nativeProject.ZBe = () => false; nativeProject.Iv = Symbol('draft-client');
for (const { value } of projectScopes) {
  assert.equal(nativeProject.clientIdentity(value.vclDraftKey, { get: (_atom, key) => `client:${key}` }), `client:${value.vclDraftKey}`);
}

// Run the actual native first-submission function; capture the request where creation would start.
const creations = []; const configurations = []; const validations = [];
let validationError;
const submission = createContext({
  globalThis: { __vscodexLayerBridge: { async validateProject(cwd) { validations.push(cwd); if (validationError) throw validationError; return { cwd }; } } },
  DOMException, Ny: (id) => `/local/${id}`, W_: Symbol(), pC: Symbol(), mC: Symbol(), Dm: Symbol(),
  DE: class extends Error {}, YA: class extends Error {}, mp: { error() {} }, Rv: () => false,
  Fyi: () => () => {}, yv: () => false, k7: { default: (fn) => fn }, EQ: (context) => context.prompt,
  eVe: () => null, qE: (items) => items, uen: null, YE: () => [],
  e$e: (roots) => roots.every((root) => root === '~'),
  TBr: async (params) => { configurations.push(params); return { ...params, fileAttachments: [], addedFiles: [], input: [{ type: 'text', text: params.prompt }], config: {} }; },
  S2e: async () => null, Lia: () => () => {}, i5e: () => async () => false, lVe: () => () => {},
});
// The VM has no module loader. Only the unused dynamic-import URL is substituted for script parsing.
runInContext(['kia', 'Aia', 'jia', 'Fia', 'Oia', 'Oxr'].map((name) => functionSource(composerSource, name)).join(';')
  .replaceAll('import.meta.url', '"https://native.test/"'), submission);
const nativeSubmit = submission.kia({ scope: { value: projectScopes[1].value, get: () => undefined },
  isMounted: () => true, intl: {}, resolvedHostId: 'local', newConversationNavigation: 'background',
  agentMode: 'auto', shouldSendPermissionOverrides: false, navigate() {},
  async startConversationWithPrimaryRuntimeForFirstTurn(params) { creations.push(params); return { status: 'failed', firstTurn: { status: 'not-started' }, message: '验证到此停止，不实际创建聊天' }; } });
assert.equal(creations.length, 0);
const firstContext = { vclProjectCwd: 'D:/Other/Project', prompt: '检查项目', fileAttachments: [], imageAttachments: [], addedFiles: [],
  existingWorkspaceRoot: 'D:/Current/Project', workspaceRoots: ['D:/Current/Project'], localProjectId: 'wrong-project' };
await assert.rejects(nativeSubmit.handleSubmitLocal(firstContext, 'D:/Current/Project', undefined,
  { hostId: 'local', workspaceRoots: ['D:/Current/Project'] }), /验证到此停止/);
assert.equal(validations[0], 'D:/Other/Project');
assert.equal(configurations[0].cwd, 'D:/Other/Project');
assert.equal(creations[0].baseParams.cwd, 'D:/Other/Project');
assert.equal(JSON.stringify(creations[0].baseParams.workspaceRoots), JSON.stringify(['D:/Other/Project']));
assert.equal(creations[0].baseParams.input[0].text, '检查项目');
validationError = new Error('目录已删除');
await assert.rejects(nativeSubmit.handleSubmitLocal(firstContext, 'D:/Current/Project'), /目录已删除/);
assert.equal(creations.length, 1, '目录失效后不能创建到当前窗口目录');
const temporaryParent = await fs.realpath(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(temporaryParent, 'vscodex-layer-adapter-'));
if (!fixture.startsWith(`${temporaryParent}${path.sep}vscodex-layer-adapter-`)) throw new Error('临时验证目录异常。');
try {
  await fs.copyFile(path.join(directory, 'package.json'), path.join(fixture, 'package.json'));
  const dependency = path.join(fixture, DRAFT_SOURCE[0]);
  await fs.mkdir(path.dirname(dependency), { recursive: true });
  await fs.writeFile(dependency, await readOriginal(directory, ...DRAFT_SOURCE));
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    const target = path.join(fixture, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readOriginal(directory, entry.path, entry.originalHash));
  }
  const result = await applyPatch(fixture, plan);
  if (result.status !== 'patched') throw new Error('补丁未完整应用。');
  if ((await applyPatch(fixture, await buildPatchPlan(fixture))).changed) throw new Error('重复应用未保持幂等。');
  for (const entry of plan.files.filter((file) => /\.(mjs|cjs|js)$/.test(file.path))) {
    // A .mjs copy lets Node parse the official ESM chunk without loading its imports.
    const checkFile = path.join(fixture, entry.path.endsWith('.cjs') ? 'syntax.cjs' : 'syntax.mjs');
    await fs.writeFile(checkFile, entry.content);
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe', windowsHide: true });
  }
  await restorePatch(fixture);
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    if (sha256(await fs.readFile(path.join(fixture, entry.path))) !== entry.originalHash) throw new Error(`恢复后校验失败：${entry.path}`);
  }
  console.log(`官方 ${plan.extensionVersion} 接入校验通过：项目目录与原生草稿隔离、配置与首次创建参数、失效目录拒绝回退，以及临时副本应用、重复应用、恢复和语法。实际插件未修改。`);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
