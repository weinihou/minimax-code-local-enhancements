import { readdir, readFile, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const issues = [];
let files = 0;
const privateNames = /^(?:\.env(?:\..*)?|state\.json|health\.json|enabled\.json|config\.ya?ml|credentials.*|.*\.(?:log|zip|asar|pem|key))$/i;
const patterns = [
  ['machine path', /\/(?:Users|Volumes|home)\/[a-zA-Z0-9_.-]+\//],
  ['real session id', /mvs_[a-zA-Z0-9]{12,}/],
  ['API key pattern', /\bsk-[a-zA-Z0-9_-]{20,}/],
  ['replacement character', /\uFFFD/],
];
// 文档截图是唯一的二进制例外：限定 docs/images/ 下的 PNG，并校验文件头，避免检查被整体绕过。
const docImage = /^docs\/images\/[A-Za-z0-9][A-Za-z0-9._-]*\.png$/;
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.DS_Store') continue;
    const path = join(dir, entry.name), name = relative(root, path);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) { issues.push(`${name}: symbolic link forbidden`); continue; }
    if (stat.isDirectory()) {
      if (['local', 'node_modules', 'work', 'lab'].includes(entry.name)) issues.push(`${name}: local-only directory inside repository`);
      else await walk(path);
      continue;
    }
    if (!stat.isFile()) { issues.push(`${name}: unsupported file type`); continue; }
    files++;
    if (privateNames.test(entry.name) && entry.name !== '.env.example') issues.push(`${name}: private/runtime file name`);
    const buffer = await readFile(path);
    if (docImage.test(name)) {
      if (!buffer.subarray(0, 8).equals(pngMagic)) issues.push(`${name}: documentation image is not a valid PNG`);
      continue;
    }
    if (buffer.includes(0)) { issues.push(`${name}: binary file requires explicit release review`); continue; }
    const text = buffer.toString('utf8');
    for (const [label, pattern] of patterns) if (pattern.test(text)) issues.push(`${name}: ${label}`);
    if (name.endsWith('.json')) { try { JSON.parse(text); } catch { issues.push(`${name}: invalid JSON`); } }
    const command = /\.(?:mjs|js)$/.test(name) ? [process.execPath, ['--check', path]] : name.endsWith('.sh') ? ['/bin/bash', ['-n', path]] : null;
    if (command) {
      const result = spawnSync(command[0], command[1], { encoding: 'utf8' });
      if (result.status !== 0) issues.push(`${name}: syntax check failed\n${result.stderr || result.error || ''}`);
    }
  }
}
await walk(root);
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${files} files; JSON, JS/Bash syntax, common privacy patterns, runtime files and symlinks checked. No application code executed.`);
