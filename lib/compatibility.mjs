import fs from 'node:fs/promises';
import path from 'node:path';
import { extensionRoot } from './patch-engine.mjs';

const count = (source, needle) => source.split(needle).length - 1;
const fileName = (file) => file.split('/').at(-1);

async function readCandidates(root, prefix) {
  const directory = path.join(root, 'webview', 'assets');
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.js'));
  return Promise.all(files.map(async (entry) => ({
    path: `webview/assets/${entry.name}`,
    content: await fs.readFile(path.join(directory, entry.name), 'utf8'),
  })));
}

function matchingFiles(files, needles) {
  return files.filter(({ content }) => needles.every((needle) => content.includes(needle)))
    .map(({ path: relative }) => relative);
}

export async function probeCompatibility(directory, strictVersion) {
  const { root, version } = await extensionRoot(directory);
  const host = await fs.readFile(path.join(root, 'out', 'extension.js'), 'utf8');
  const html = await fs.readFile(path.join(root, 'webview', 'index.html'), 'utf8');
  const moduleEntries = [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);
  const appFiles = await readCandidates(root, 'app-initial-');
  const headerFiles = await readCandidates(root, 'header-');
  const hostAnchor = 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),';
  const routeCandidates = matchingFiles(appFiles,
    ['navigate-to-route', '/extension/panel/new', 'routeTemplate']);
  const composerCandidates = matchingFiles(appFiles,
    ['activeWorkspaceRoot', 'selectedRemoteProject', 'workspaceRoots']);
  const headerCandidates = matchingFiles(headerFiles, ['header.recentChats', 'tasksQuery']);
  const checks = {
    officialExtension: true,
    singleModuleEntry: moduleEntries.length === 1,
    hostBridgeAnchor: count(host, hostAnchor) === 1,
    routeModuleDiscoverable: routeCandidates.length >= 1,
    composerModuleDiscoverable: composerCandidates.length >= 1,
    headerModuleDiscoverable: headerCandidates.length === 1,
  };
  return {
    root,
    version,
    mode: version === strictVersion ? 'strict' : 'unknown-version',
    compatible: version === strictVersion && Object.values(checks).every(Boolean),
    checks,
    discovered: {
      moduleEntries,
      routeCandidates: routeCandidates.map(fileName),
      composerCandidates: composerCandidates.map(fileName),
      headerCandidates: headerCandidates.map(fileName),
    },
  };
}
