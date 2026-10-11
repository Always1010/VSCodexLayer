import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIRECTORY = /^openai\.chatgpt-(.+)-(win32-x64|linux-x64|linux-arm64)$/;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function readOptionalJson(file) {
  try { return await readJson(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function candidatesIn(parent, platform) {
  const obsoleteFile = path.join(parent, '.obsolete');
  const obsolete = await readOptionalJson(obsoleteFile) ?? {};
  const installed = await readOptionalJson(path.join(parent, 'extensions.json'));
  if (installed !== null && !Array.isArray(installed)) throw new Error(`插件安装清单格式无效：${parent}`);
  let entries;
  try { entries = await fs.readdir(parent, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const candidates = [];
  for (const entry of entries) {
    const match = entry.isDirectory() && DIRECTORY.exec(entry.name);
    if (!match || match[2] !== platform) continue;
    const root = path.join(parent, entry.name);
    let manifest;
    try { manifest = await readJson(path.join(root, 'package.json')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (manifest.name !== 'chatgpt' || manifest.publisher !== 'openai' || manifest.version !== match[1]) continue;
    const listed = installed === null || installed.some((item) => item.identifier?.id === 'openai.chatgpt'
      && item.version === manifest.version && item.relativeLocation === entry.name
      && (!item.metadata?.targetPlatform || item.metadata.targetPlatform === platform));
    candidates.push({ root, version: manifest.version, platform,
      obsolete: obsolete[`openai.chatgpt-${manifest.version}`] === true || obsolete[entry.name] === true,
      listed });
  }
  return candidates;
}

export async function findInstalledExtension(parent, {
  platform = `${process.platform}-${process.arch}`, home = os.homedir(), select,
} = {}) {
  const parents = parent ? [parent] : platform.startsWith('linux-')
    ? [path.join(home, '.vscode-server', 'extensions'), path.join(home, '.vscode', 'extensions')]
    : [path.join(home, '.vscode', 'extensions')];
  const candidates = (await Promise.all(parents.map((directory) => candidatesIn(directory, platform)))).flat();
  const active = candidates.filter((candidate) => !candidate.obsolete && candidate.listed)
    .sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }));
  if (active.length === 0) {
    throw new Error('未找到当前启用的官方 Codex 插件。请使用 --extension 指定安装目录。');
  }
  const choices = parents.map((directory) => active.find((candidate) => path.dirname(candidate.root) === directory))
    .filter(Boolean);
  if (choices.length > 1) {
    if (!select) throw new Error('本地和远程插件目录均有安装，无法确定当前宿主。请在交互终端选择，或使用 --extension 指定实际运行的插件目录。');
    const selected = await select(choices);
    if (!choices.includes(selected)) throw new Error('未选择有效的插件目录，已取消操作。');
    return { ...selected, candidates };
  }
  return { ...active[0], candidates };
}
