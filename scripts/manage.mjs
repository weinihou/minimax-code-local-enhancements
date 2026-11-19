#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createInstaller, NAME, noSymlinks } from './installer.mjs';

function parse(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (key === 'apply') { if (key in flags) throw Error('Duplicate --apply'); flags.apply = true; continue; }
    if (!['data-dir', 'source-data-dir', 'icon', 'dark-icon', 'enabled', 'background', 'autostart', 'auto-restart'].includes(key)) throw Error('Unknown option: ' + arg);
    if (key in flags || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('Missing or duplicate option: ' + arg);
    flags[key] = argv[++i];
  }
  return { positional, flags };
}
const HELP = `MCode 本地增强 0.2.0

npm run manage -- install [--icon FILE --dark-icon FILE] [--apply]
npm run manage -- migrate [--icon FILE --dark-icon FILE] [--apply]
npm run manage -- rollback [--apply]
npm run manage -- status
npm run manage -- configure MODULE --background on|off --autostart on|off --auto-restart on|off
npm run manage -- start MODULE
npm run manage -- stop MODULE
npm run manage -- repair MODULE

MODULE: quotabar | credit-guard
Common option: --data-dir DIR (defaults to MINIMAX_DATA_DIR or current user's .minimax)
Install/migrate/rollback are read-only previews unless --apply is supplied.
Installation does not enable modules. Choose permissions explicitly, then start.
Stopping a module disables it; policy choices are retained but do not run while disabled.
Automatic restart is supported only for quotabar and requires explicit background permission.
`;
try {
  const { positional, flags } = parse(process.argv.slice(2));
  const [action, module, ...extra] = positional;
  if (!action || action === 'help') { console.log(HELP); }
  else {
    if (extra.length) throw Error('Unexpected positional arguments');
    const dataDir = resolve(flags['data-dir'] || process.env.MINIMAX_DATA_DIR || join(homedir(), '.minimax'));
    let result;
    if (['install', 'migrate', 'rollback'].includes(action)) {
      if (module || Object.keys(flags).some(key => !['data-dir', 'source-data-dir', 'icon', 'dark-icon', 'apply'].includes(key))) throw Error('Unexpected installation arguments');
      const installer = createInstaller();
      const options = { dataDir, sourceDataDir: flags['source-data-dir'], icon: flags.icon, darkIcon: flags['dark-icon'], apply: flags.apply === true, migrate: action === 'migrate' };
      result = action === 'rollback' ? await installer.rollback(options) : await installer.apply(options);
    } else {
      if (Object.keys(flags).some(key => !['data-dir', 'enabled', 'background', 'autostart', 'auto-restart'].includes(key))) throw Error('Unexpected module control arguments');
      const pluginRoot = join(dataDir, 'plugins', NAME);
      if (action !== 'status') {
        await noSymlinks(pluginRoot);
        let manifest;
        try { manifest = JSON.parse(await readFile(join(pluginRoot, '.minimax-plugin/plugin.json'), 'utf8')); }
        catch { throw Error('Install or migrate the unified package before module control; no state changed'); }
        if (manifest.name !== NAME) throw Error('Unified installation identity mismatch');
        for (const legacy of ['quotabar', 'credit-guard']) {
          let present;
          try { present = !!await lstat(join(dataDir, 'plugins', legacy)); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (present) throw Error('Legacy plugin still present; complete offline migration before module control');
        }
      }
      const { createController } = await import('../runtime/control.mjs');
      const controller = createController({ dataDir, pluginRoot });
      if (action === 'status') {
        if (module || Object.keys(flags).some(key => key !== 'data-dir')) throw Error('Status takes no module or permission flags');
        result = await controller.status();
      } else if (action === 'configure') {
        const changes = {};
        const names = { enabled: 'enabled', background: 'background', autostart: 'autostart', 'auto-restart': 'autoRestart' };
        for (const [flag, property] of Object.entries(names)) if (flag in flags) {
          if (!['on', 'off'].includes(flags[flag])) throw Error('--' + flag + ' must be on or off');
          changes[property] = flags[flag] === 'on';
        }
        if (!Object.keys(changes).length) throw Error('Specify at least one permission choice');
        result = await controller.configure(module, changes);
      } else if (['start', 'stop', 'repair'].includes(action)) {
        if (Object.keys(flags).some(key => key !== 'data-dir')) throw Error('Use configure to choose permissions before control actions');
        result = await controller[action](module);
      } else throw Error('Unknown action: ' + action);
    }
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
