import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJSON, moduleName } from './config.mjs';
const STATES = ['starting', 'injected', 'unavailable', 'blocked', 'deferred', 'restarted', 'stopped'];
const REASONS = ['daemon-start-requested', 'supervisor-failed', 'app-page-unavailable', 'permission-revoked', 'cdp-unavailable', 'global-idle-unproven', 'cooldown-or-permission-revoked', 'application-already-closed', 'global-idle-recheck-failed', 'graceful-quit-not-complete', 'permission-revoked-after-quit', 'global-idle-confirmed', 'restart-check-or-operation-failed', 'supervisor-exited', 'unknown'];
export async function writeRuntimeSummary(dir, name, value) {
  moduleName(name);
  const summary = {
    state: STATES.includes(value?.state) ? value.state : 'unavailable',
    reason: REASONS.includes(value?.reason) ? value.reason : 'unknown',
    at: Date.now(),
  };
  if (Number.isInteger(value?.consecutiveFailures) && value.consecutiveFailures >= 0) summary.consecutiveFailures = Math.min(value.consecutiveFailures, 1000000000);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicJSON(join(dir, `${name}-runtime.json`), summary);
}
export async function readRuntimeSummary(dir, name) {
  moduleName(name);
  try {
    const s = JSON.parse(await readFile(join(dir, `${name}-runtime.json`), 'utf8'));
    if (!s || !STATES.includes(s.state) || !REASONS.includes(s.reason) || !Number.isFinite(s.at) || Object.keys(s).some(k => !['state', 'reason', 'at', 'consecutiveFailures'].includes(k)) || (s.consecutiveFailures !== undefined && (!Number.isInteger(s.consecutiveFailures) || s.consecutiveFailures < 0))) throw Error('Invalid summary');
    return s;
  } catch (e) { return e.code === 'ENOENT' ? null : { state: 'unavailable', reason: 'invalid-runtime-summary' }; }
}
