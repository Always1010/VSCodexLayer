import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

export function syntaxType(relative) {
  if (relative.endsWith('.cjs') || relative === 'out/extension.js') return 'commonjs';
  if (relative.endsWith('.mjs') || /^webview\/assets\/.*\.js$/.test(relative)) return 'module';
  return relative.endsWith('.js') ? 'script' : null;
}

// Parse only: generated imports and host code must never execute during preflight.
export function validateGeneratedCode(plan) {
  if (!Array.isArray(plan.files) || !plan.files.length) throw new Error('补丁文件清单为空。');
  for (const entry of plan.files) {
    if (typeof entry.path !== 'string' || !(typeof entry.content === 'string' || Buffer.isBuffer(entry.content))) {
      throw new Error('补丁路径或内容无效。');
    }
    const type = entry.syntax ?? syntaxType(entry.path);
    if (type === null) continue;
    if (!['script', 'module', 'commonjs'].includes(type)) throw new Error(`补丁解析类型无效：${entry.path}`);
    try {
      if (type === 'script') new vm.Script(entry.content.toString(), { filename: entry.path });
      else execFileSync(process.execPath, ['--check', `--input-type=${type}`], {
        input: entry.content, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        timeout: 30000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`生成代码语法检查失败：${entry.path}\n${error.stderr?.toString() || error.message}`, { cause: error });
    }
  }
  return plan;
}
