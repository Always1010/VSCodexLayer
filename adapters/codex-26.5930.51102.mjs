import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extensionRoot, readOriginal } from '../lib/patch-engine.mjs';

export const VERSION = '26.5930.51102';
export const ADAPTER = `codex-${VERSION}-v1`;
const ORIGINALS = [
  ['out/extension.js', '1f051b97e1388816133ba9a5070832bf77ccd3e47b47fbda88f7a3d0be809e40'],
  ['webview/index.html', '27936dc2b6826728ba4e65a129f4603d2137102a37ba61417f2a7cf106d1b4a1'],
  ['webview/assets/app-initial-3a0869cff48f.js', '1db99374c9fecea31a0c54cf5fffa6c996346b15bc712085b44981526d698316'],
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
    'globalThis.__vscodexLayerBridge?.observeRoute(r.pathname);' + routeAnchor);
  const assets = [
    ['runtime/host.cjs', 'out/vscodex-layer-host.cjs'],
    ['webview/bootstrap.js', 'webview/vscodex-layer/bootstrap.js'],
    ['webview/client.mjs', 'webview/vscodex-layer/client.mjs'],
    ['webview/layer.mjs', 'webview/vscodex-layer/layer.mjs'],
    ['webview/layer.css', 'webview/vscodex-layer/layer.css'],
  ];
  for (const [source, target] of assets) {
    originals.push({ path: target, originalHash: null,
      content: await fs.readFile(fileURLToPath(new URL(`../${source}`, import.meta.url))) });
  }
  return { adapter: ADAPTER, extensionVersion: VERSION, files: originals };
}
