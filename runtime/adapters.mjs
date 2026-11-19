import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { proveGlobalIdle } from './idle-proof.mjs';
export const QUOTABAR_DISPOSE = `(()=>{const S=window.__QB_QUOTA__;if(!S)return true;clearInterval(S.timer);clearInterval(S.hoverTimer);clearTimeout(S.layoutTimer);S.obs?.disconnect();window.removeEventListener('resize',S.onResize);document.removeEventListener('mousemove',S.onMove,true);document.removeEventListener('mouseleave',S.onMove,true);window.removeEventListener('blur',S.onMove);for(const id of ['qb-quota-bar','qb-quota-tip','qb-quota-style'])document.getElementById(id)?.remove();delete window.__QB_QUOTA__;return true})()`;
export async function quotabarLibrary(root) {
  return import(pathToFileURL(join(root, 'modules/quotabar/src/quotabar.mjs')).href);
}
export function pageAdapters(root, port, dataDir) {
  return {
    async inject() {
      const q = await quotabarLibrary(root);
      const result = await q.injectOnce(port);
      return { injected: result?.ok === true, status: typeof result?.status === 'string' ? result.status : null };
    },
    async portAvailable() {
      try { return (await (await quotabarLibrary(root)).listTargets(port)).some(t => t.url?.startsWith('app://')); }
      catch { return false; }
    },
    async proveIdle() {
      return proveGlobalIdle({ dataDir, evaluate: async expression => (await quotabarLibrary(root)).evalInApp(expression, port) });
    },
    async dispose() { return (await quotabarLibrary(root)).evalInApp(QUOTABAR_DISPOSE, port); },
  };
}
