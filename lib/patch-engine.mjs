import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const BACKUP = '.vscodex-layer';
const LOCK = '.vscodex-layer.lock';
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function readOptional(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function extensionRoot(directory) {
  const root = await fs.realpath(directory);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'chatgpt' || manifest.publisher !== 'openai') {
    throw new Error('目标目录不是官方 openai.chatgpt 插件。');
  }
  return { root, version: manifest.version };
}

async function safeTarget(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
    || relative.includes('\\') || relative.split('/').some((part) => !part || part === '..' || part === '.')) {
    throw new Error(`无效的补丁路径：${relative}`);
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('补丁路径越出插件目录。');
  let cursor = root;
  for (const part of relative.split('/')) {
    cursor = path.join(cursor, part);
    try {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error(`不修改符号链接：${relative}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

async function atomicWrite(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

async function withLock(root, work) {
  const lock = await fs.open(path.join(root, LOCK), 'wx').catch((error) => {
    if (error.code === 'EEXIST') throw new Error('另一补丁操作尚未结束；若进程意外退出，请检查后移除 .vscodex-layer.lock。');
    throw error;
  });
  try { return await work(); }
  finally { await lock.close(); await fs.unlink(path.join(root, LOCK)); }
}

async function readRecord(root) {
  const file = await safeTarget(root, `${BACKUP}/manifest.json`);
  const bytes = await readOptional(file);
  if (bytes === null) return null;
  const record = JSON.parse(bytes.toString('utf8'));
  if (record.schema !== 1 || !Array.isArray(record.files) || record.files.length === 0
    || new Set(record.files.map((entry) => entry.path)).size !== record.files.length) {
    throw new Error('补丁备份清单损坏，停止操作。');
  }
  for (const entry of record.files) {
    await safeTarget(root, entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.patchedHash)
      || (entry.originalHash !== null && !/^[a-f0-9]{64}$/.test(entry.originalHash))) {
      throw new Error('补丁备份校验值无效。');
    }
  }
  return record;
}

export async function inspectPatch(directory) {
  const { root, version } = await extensionRoot(directory);
  const record = await readRecord(root);
  if (record === null) return { root, version, status: 'original' };
  const files = [];
  for (const entry of record.files) {
    const bytes = await readOptional(await safeTarget(root, entry.path));
    const hash = bytes === null ? null : sha256(bytes);
    files.push({ path: entry.path, status: hash === entry.patchedHash ? 'patched'
      : hash === entry.originalHash ? 'original' : 'conflict' });
  }
  const status = version !== record.extensionVersion ? 'version-changed'
    : files.some((entry) => entry.status === 'conflict') ? 'conflict'
      : files.every((entry) => entry.status === 'patched') ? 'patched' : 'partial';
  return { root, version, status, adapter: record.adapter, files };
}

export async function readOriginal(directory, relative, expectedHash) {
  const { root } = await extensionRoot(directory);
  let bytes = await readOptional(await safeTarget(root, relative));
  if (bytes !== null && sha256(bytes) === expectedHash) return bytes;
  const record = await readRecord(root);
  const index = record?.files.findIndex((entry) => entry.path === relative) ?? -1;
  const entry = record?.files[index];
  if (entry?.originalHash === expectedHash && entry.backup === `${index}.original`) {
    bytes = await readOptional(await safeTarget(root, `${BACKUP}/${entry.backup}`));
    if (bytes !== null && sha256(bytes) === expectedHash) return bytes;
  }
  throw new Error(`官方文件校验不匹配，停止生成补丁：${relative}`);
}

export async function readUnpatched(directory, relative) {
  const { root } = await extensionRoot(directory);
  const target = await safeTarget(root, relative);
  let bytes = await readOptional(target);
  const record = await readRecord(root);
  if (record === null) {
    if (bytes === null) throw new Error(`官方文件不存在：${relative}`);
    return bytes;
  }
  const index = record.files.findIndex((entry) => entry.path === relative);
  if (index < 0) {
    if (bytes === null) throw new Error(`官方文件不存在：${relative}`);
    return bytes;
  }
  const entry = record.files[index];
  const currentHash = bytes === null ? null : sha256(bytes);
  if (currentHash === entry.originalHash) return bytes;
  if (currentHash !== entry.patchedHash) throw new Error(`文件被其他操作修改，停止读取原件：${relative}`);
  if (entry.originalHash === null || entry.backup !== `${index}.original`) {
    throw new Error(`新增资源没有官方原件：${relative}`);
  }
  bytes = await readOptional(await safeTarget(root, `${BACKUP}/${entry.backup}`));
  if (bytes === null || sha256(bytes) !== entry.originalHash) throw new Error(`补丁备份损坏：${relative}`);
  return bytes;
}

export async function validatePlan(directory, plan) {
  const { root, version } = await extensionRoot(directory);
  return validateOriginals(root, version, plan);
}

async function validateOriginals(root, version, plan, restoredFiles = new Map()) {
  if (version !== plan.extensionVersion) throw new Error(`不支持插件版本 ${version}，目标为 ${plan.extensionVersion}。`);
  if (!plan.files?.length || new Set(plan.files.map((entry) => entry.path)).size !== plan.files.length) {
    throw new Error('补丁文件清单为空或包含重复路径。');
  }
  for (const entry of plan.files) {
    const file = await safeTarget(root, entry.path);
    const bytes = restoredFiles.has(file) ? restoredFiles.get(file) : await readOptional(file);
    const hash = bytes === null ? null : sha256(bytes);
    if (hash !== entry.originalHash) throw new Error(`文件不是预期原件，停止修改：${entry.path}`);
    if (!(typeof entry.content === 'string' || Buffer.isBuffer(entry.content))) throw new Error('补丁内容无效。');
  }
  await safeTarget(root, `${BACKUP}/manifest.json`);
  return { root, version, files: plan.files.map((entry) => entry.path) };
}

export async function applyPatch(directory, plan) {
  const { root, version } = await extensionRoot(directory);
  return withLock(root, async () => {
    const existing = await readRecord(root);
    if (existing !== null) {
      const state = await inspectPatch(root);
      const same = existing.adapter === plan.adapter && existing.files.length === plan.files.length
        && existing.extensionVersion === plan.extensionVersion
        && existing.files.every((entry) => plan.files.some((file) => file.path === entry.path
          && file.originalHash === entry.originalHash && sha256(file.content) === entry.patchedHash));
      if (state.status === 'patched' && same) return { ...state, changed: false };
      if (state.status !== 'patched') throw new Error(`当前状态为 ${state.status}，请先检查备份和冲突；未完成的操作请恢复后重试。`);
      const restoration = await prepareRestoration(root, version, existing);
      // Validate the next patch against the restored originals before removing the working patch.
      await validateOriginals(root, version, plan,
        new Map(restoration.map(({ target, original }) => [target, original])));
      await restoreFiles(root, existing, restoration);
    }
    await validatePlan(root, plan);
    const backupDirectory = path.join(root, BACKUP);
    await fs.mkdir(backupDirectory, { recursive: false });
    const record = { schema: 1, adapter: plan.adapter, extensionVersion: plan.extensionVersion,
      createdAt: new Date().toISOString(), state: 'prepared', files: [] };
    const manifestFile = path.join(backupDirectory, 'manifest.json');
    const createdBackups = [];
    try {
      for (const [index, entry] of plan.files.entries()) {
        if (entry.originalHash !== null) {
          const bytes = await fs.readFile(await safeTarget(root, entry.path));
          const backup = path.join(backupDirectory, `${index}.original`);
          await fs.writeFile(backup, bytes, { flag: 'wx' });
          createdBackups.push(backup);
        }
        record.files.push({ path: entry.path, originalHash: entry.originalHash,
          patchedHash: sha256(entry.content), backup: entry.originalHash === null ? null : `${index}.original` });
      }
      await atomicWrite(manifestFile, JSON.stringify(record, null, 2));
    } catch (error) {
      for (const backup of createdBackups) await fs.rm(backup, { force: true });
      await fs.rmdir(backupDirectory);
      throw error;
    }
    // The complete recovery journal exists before touching any official file.
    for (const entry of plan.files) {
      const target = await safeTarget(root, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWrite(target, entry.content);
    }
    record.state = 'applied';
    await atomicWrite(manifestFile, JSON.stringify(record, null, 2));
    return { ...(await inspectPatch(root)), changed: true };
  });
}

export async function restorePatch(directory) {
  const { root, version } = await extensionRoot(directory);
  return withLock(root, async () => {
    const record = await readRecord(root);
    if (record === null) return { root, version, status: 'original', changed: false };
    const restoration = await prepareRestoration(root, version, record);
    await restoreFiles(root, record, restoration);
    return { root, version, status: 'original', changed: true };
  });
}

async function prepareRestoration(root, version, record) {
  if (record.extensionVersion !== version) throw new Error('官方插件版本已经改变，不能用旧备份覆盖新版本。');
  const restoration = [];
  // Preflight every file and backup before restoring any of them.
  for (const [index, entry] of record.files.entries()) {
    const target = await safeTarget(root, entry.path);
    const current = await readOptional(target);
    const hash = current === null ? null : sha256(current);
    if (hash !== entry.patchedHash && hash !== entry.originalHash) {
      throw new Error(`文件被其他操作修改，停止恢复：${entry.path}`);
    }
    let original = null;
    if (entry.originalHash !== null) {
      if (entry.backup !== `${index}.original`) throw new Error('原件备份路径无效。');
      original = await readOptional(await safeTarget(root, `${BACKUP}/${entry.backup}`));
      if (original === null && hash === entry.originalHash) original = current;
      if (original === null) throw new Error(`原件备份缺失：${entry.path}`);
      if (sha256(original) !== entry.originalHash) throw new Error(`原件备份损坏：${entry.path}`);
    }
    restoration.push({ target, original });
  }
  return restoration;
}

async function restoreFiles(root, record, restoration) {
  for (const { target, original } of restoration) {
    if (original === null) await fs.rm(target, { force: true });
    else await atomicWrite(target, original);
  }
  for (const entry of record.files) {
    if (entry.backup !== null) await fs.rm(path.join(root, BACKUP, entry.backup), { force: true });
  }
  await fs.unlink(path.join(root, BACKUP, 'manifest.json'));
  await fs.rmdir(path.join(root, BACKUP));
}
