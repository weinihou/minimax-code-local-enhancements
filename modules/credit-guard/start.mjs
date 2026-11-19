import { ensureRunning } from './control.mjs';

try {
  const result = await ensureRunning();
  if (result.supported === false || result.error) {
    process.stderr.write(`credit-guard: ${result.message || result.error}\n`);
  }
} catch {
  process.stderr.write('credit-guard: 无法检查或启动本地守护。\n');
}
