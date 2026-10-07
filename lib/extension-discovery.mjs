import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DIRECTORY = /^openai\.chatgpt-(.+)-win32-x64$/;

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export async function findInstalledExtension(parent = path.join(os.homedir(), '.vscode', 'extensions')) {
  const obsoleteFile = path.join(parent, '.obsolete');
  let obsolete = {};
  try { obsolete = await readJson(obsoleteFile); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const candidates = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    const match = entry.isDirectory() && DIRECTORY.exec(entry.name);
    if (!match) continue;
    const root = path.join(parent, entry.name);
    let manifest;
    try { manifest = await readJson(path.join(root, 'package.json')); }
    catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) continue; throw error; }
    if (manifest.name !== 'chatgpt' || manifest.publisher !== 'openai' || manifest.version !== match[1]) continue;
    candidates.push({ root, version: manifest.version,
      obsolete: obsolete[`openai.chatgpt-${manifest.version}`] === true });
  }
  const active = candidates.filter((candidate) => !candidate.obsolete)
    .sort((left, right) => right.version.localeCompare(left.version, 'en', { numeric: true }));
  if (active.length === 0) {
    throw new Error('未找到当前启用的官方 Codex 插件。请使用 --extension 指定安装目录。');
  }
  return { ...active[0], candidates };
}
