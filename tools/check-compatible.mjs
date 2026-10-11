import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { buildCompatiblePatchPlan } from '../adapters/codex-compatible.mjs';
import { applyPatch, inspectPatch, readUnpatched, restorePatch, sha256 } from '../lib/patch-engine.mjs';
import { findExtension } from './layer.mjs';
import { checkProjectSubmit } from './native-project-submit.mjs';
import { checkNativeReasoning } from './native-reasoning.mjs';

const args = process.argv.slice(2);
if (args.length && (args[0] !== '--extension' || args.length !== 2)) {
  throw new Error('用法：node tools/check-compatible.mjs [--extension 路径]');
}
const directory = args[1] ?? await findExtension();
const plan = await buildCompatiblePatchPlan(directory);
const byPath = (relative) => plan.files.find((entry) => entry.path === relative)?.content.toString();
const route = byPath(plan.compatibility.route);
const composer = byPath(plan.compatibility.composer);
const header = byPath(plan.compatibility.header);
const host = byPath('out/extension.js');
const hostNamespace = /require\(([A-Za-z_$][\w$]*)\.Uri\.joinPath\([^)]*"vscodex-layer-host\.cjs"[^)]*\)[\s\S]{0,240}?createLayerHost\(\{vscode:\1,/.exec(host);
assert.ok(hostNamespace, '宿主注入必须复用当前构建的 VS Code API 命名空间');
// Execute the generated entry with only identifiers present in the official source.
// Syntax and marker checks alone cannot detect undefined minified identifiers.
const originalHost = (await readUnpatched(directory, 'out/extension.js')).toString();
const originalNamespace = /let [A-Za-z_$][\w$]*=([A-Za-z_$][\w$]*)\.Uri\.joinPath\(this\.extensionUri,"webview"\)/.exec(originalHost)?.[1];
const originalWslHelper = /function ([A-Za-z_$][\w$]*)\(\)\{return [A-Za-z_$][\w$]*\("runCodexInWindowsSubsystemForLinux",!1\)\?/.exec(originalHost)?.[1];
assert.ok(originalNamespace && originalWslHelper, '官方宿主必须包含 VS Code API 和 WSL 运行模式判断');
const injectionStart = host.indexOf('let __vclHost;');
const injectionEnd = host.indexOf('let a=e.onDidReceiveMessage', injectionStart);
assert.ok(injectionStart >= 0 && injectionEnd > injectionStart);
const injectedEntry = new vm.Script(`(function(){${host.slice(injectionStart, injectionEnd)}return __vclHost;}).call(provider)`);
const { createLayerHost } = createRequire(import.meta.url)('../runtime/host.cjs');
const replies = [];
const warnings = [];
let backendInWsl = false;
const disposable = () => ({ dispose() {} });
const extensionUri = { scheme: 'file', fsPath: directory };
const vscode = { Uri: { joinPath: (root, ...parts) => ({ fsPath: path.join(root.fsPath, ...parts) }) }, env: {},
  ExtensionKind: { UI: 1, Workspace: 2 },
  extensions: { getExtension: () => ({ extensionKind: 2, extensionUri }) },
  workspace: { workspaceFolders: [], onDidChangeWorkspaceFolders: disposable } };
const provider = { extensionUri, subscriptions: [], extensionVersion: plan.extensionVersion,
  logger: { warning: (message) => warnings.push(message) }, globalState: { get: () => ({}) },
  codexMcpConnection: { registerProvider: disposable, registerInternalNotificationHandler: disposable } };
const context = vm.createContext({ provider, [originalNamespace]: vscode, [originalWslHelper]: () => backendInWsl,
  e: { postMessage: (message) => replies.push(message) }, n: disposable,
  require: (target) => {
    assert.equal(target, path.join(directory, 'out', 'vscodex-layer-host.cjs'));
    return { createLayerHost };
  } });
const initializedHost = injectedEntry.runInContext(context, { timeout: 1000 });
try {
  assert.ok(initializedHost, `生成的宿主入口初始化失败：${warnings.join('\n')}`);
  assert.equal(provider.subscriptions[0], initializedHost);
  for (const [remoteName, wsl, supported] of [[undefined, false, true], [undefined, true, false], ['wsl', false, false],
    ['ssh-remote', false, process.platform === 'linux'], ['dev-container', false, false]]) {
    vscode.env.remoteName = remoteName;
    backendInWsl = wsl;
    vscode.workspace.workspaceFolders = remoteName === 'ssh-remote'
      ? [{ name: 'Remote', uri: { scheme: 'file', authority: '', fsPath: '/home/ubuntu/project' } }]
      : [];
    assert.equal(initializedHost.handle({ type: 'vscodex-layer/request', id: 'init', method: 'init' }), true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(replies.at(-1)?.result?.supported, supported, '宿主初始化必须识别本地、SSH 和 WSL 支持边界');
  }
  assert.equal(warnings.length, 0);
} finally { initializedHost?.dispose(); }
context.require = () => { throw new Error('host-load-regression'); };
assert.equal(injectedEntry.runInContext(context, { timeout: 1000 }), undefined);
assert.match(warnings.at(-1), /host-load-regression/, '宿主加载失败必须记录实际异常');
assert.equal((route.match(/projectRoute\(/g) ?? []).length, 1);
assert.equal((route.match(/vclDraftKey/g) ?? []).length, 13);
assert.equal((composer.match(/projectCwd\(/g) ?? []).length, 5);
assert.equal((composer.match(/validateProject\(/g) ?? []).length, 1);
assert.equal((header.match(/data-vcl-home-history/g) ?? []).length, 2);
assert.equal((header.match(/data-vcl-chat-back/g) ?? []).length, 1);
await checkNativeReasoning(plan);

const runtimeFiles = [];
for (const name of await fs.readdir(path.join(directory, 'webview', 'assets'))) {
  if (!name.startsWith('app-initial-') || !name.endsWith('.js')) continue;
  const source = (await readUnpatched(directory, `webview/assets/${name}`)).toString();
  if (source.includes('canUseProjectlessWorkspace&&') && source.includes('createProjectlessThreadWorkspace')) runtimeFiles.push(source);
}
assert.equal(runtimeFiles.length, 1, '首次消息工作区运行时必须唯一');
const regressionComposer = composer.replace(/baseParams:[\w$]+\.vclProjectCwd!==undefined\?\{\.\.\.([\w$]+),projectAssignment:undefined\}:[\w$]+,prepareFirstTurn:/,
  'baseParams:$1,prepareFirstTurn:');
assert.notEqual(regressionComposer, composer);
await checkProjectSubmit(regressionComposer, runtimeFiles[0], /projectless-thread-cwd not supported in extension/);
await checkProjectSubmit(composer, runtimeFiles[0]);

const temporaryParent = await fs.realpath(os.tmpdir());
const fixture = await fs.mkdtemp(path.join(temporaryParent, 'vscodex-layer-compatible-'));
if (!fixture.startsWith(`${temporaryParent}${path.sep}vscodex-layer-compatible-`)) throw new Error('临时验证目录异常。');
try {
  await fs.copyFile(path.join(directory, 'package.json'), path.join(fixture, 'package.json'));
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    const target = path.join(fixture, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, await readUnpatched(directory, entry.path));
  }
  if ((await inspectPatch(directory)).status === 'patched') {
    const previous = JSON.parse(await fs.readFile(path.join(directory, '.vscodex-layer', 'manifest.json'), 'utf8'));
    const previousFiles = await Promise.all(previous.files.map(async (entry) => {
      const content = await fs.readFile(path.join(directory, entry.path));
      assert.equal(sha256(content), entry.patchedHash, '已安装补丁必须与校验清单一致');
      return { path: entry.path, originalHash: entry.originalHash, content };
    }));
    await applyPatch(fixture, { adapter: previous.adapter, extensionVersion: previous.extensionVersion, files: previousFiles });
  }
  // Also exercise updating the currently installed navigation-only patch in the fixture.
  const result = await applyPatch(fixture, await buildCompatiblePatchPlan(fixture));
  assert.equal(result.status, 'patched');
  const rebuilt = await buildCompatiblePatchPlan(fixture);
  assert.equal((await applyPatch(fixture, rebuilt)).changed, false);
  for (const entry of plan.files.filter((file) => /\.(mjs|cjs|js)$/.test(file.path))) {
    const checkFile = path.join(fixture, entry.path.endsWith('.cjs') ? 'syntax.cjs' : 'syntax.mjs');
    await fs.writeFile(checkFile, entry.content);
    execFileSync(process.execPath, ['--check', checkFile], { stdio: 'pipe', windowsHide: true });
  }
  await restorePatch(fixture);
  for (const entry of plan.files.filter((file) => file.originalHash !== null)) {
    assert.equal(sha256(await fs.readFile(path.join(fixture, entry.path))), entry.originalHash);
  }
  console.log(`官方 ${plan.extensionVersion} 兼容结构校验通过：${plan.compatibility.family}；推理摘要分类、原生展开／折叠与流式正文、开关恢复、动态资源、宿主初始化、SSH / WSL 边界、项目首条消息归属与目录、语法、临时副本应用、已安装补丁更新、重复应用和恢复均通过。实际插件未修改。`);
} finally { await fs.rm(fixture, { recursive: true, force: true }); }
