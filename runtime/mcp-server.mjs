import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { createController } from './control.mjs';

const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
const dataDir = process.env.MINIMAX_DATA_DIR || resolve(pluginRoot, '../..');
const controller = createController({ pluginRoot, dataDir });
const moduleSchema = { type: 'string', enum: ['quotabar', 'credit-guard'] };
const choices = { type: 'object', properties: Object.fromEntries(['enabled', 'background', 'autostart', 'autoRestart'].map(key => [key, { type: 'boolean' }])), additionalProperties: false, minProperties: 1 };
const tools = [
  { name: 'enhancements_status', description: '只读查询两个模块状态与主动授权设置；不启动、不修复。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'enhancements_configure', description: '按用户明确选择分别设置模块启用、后台常驻、登录自启动、自动重启。未明确授权的字段不得开启。撤销授权会停止相应后台；不会重启客户端。', inputSchema: { type: 'object', properties: { module: moduleSchema, changes: choices }, required: ['module', 'changes'], additionalProperties: false } },
  ...['start', 'stop', 'repair'].map(action => ({ name: 'enhancements_' + action,
    description: { start: '启用所选模块；遵守已有后台权限，不隐式授予权限。积分限额需先同意后台常驻。', stop: '独立停用所选模块并撤销运行中的后台与自启动登记，保留权限选择；不自动续跑会话。', repair: '仅修复已启用模块，遵守已有授权，不开启被停用模块，不重启应用。' }[action],
    inputSchema: { type: 'object', properties: { module: moduleSchema }, required: ['module'], additionalProperties: false } })),
];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
async function handle(message) {
  const { id, method, params } = message;
  if (id === undefined) return;
  const reply = result => send({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') return reply({ protocolVersion: '2024-11-05', serverInfo: { name: 'mcode-local-enhancements', version: '0.2.0' }, capabilities: { tools: {} } });
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools });
  if (method !== 'tools/call') return send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  try {
    const tool = tools.find(tool => tool.name === params?.name);
    if (!tool) throw Error('Unknown tool');
    const args = params.arguments || {};
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('Arguments must be an object');
    const allowed = Object.keys(tool.inputSchema.properties);
    if (Object.keys(args).some(key => !allowed.includes(key))) throw Error('Unknown argument');
    if (params.name !== 'enhancements_status' && !moduleSchema.enum.includes(args.module)) throw Error('Invalid module');
    if (params.name !== 'enhancements_status') {
      const manifest = JSON.parse(await readFile(join(pluginRoot, '.minimax-plugin/plugin.json'), 'utf8'));
      if (manifest.name !== 'mcode-local-enhancements') throw Error('Unified installation required');
      for (const legacy of ['quotabar', 'credit-guard']) {
        let present;
        try { present = !!await lstat(join(dataDir, 'plugins', legacy)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (present) throw Error('Legacy plugin still present; complete offline migration before module control');
      }
    }
    let result;
    if (params.name === 'enhancements_status') result = await controller.status();
    else if (params.name === 'enhancements_configure') {
      if (!args.changes || Array.isArray(args.changes) || typeof args.changes !== 'object' || !Object.keys(args.changes).length) throw Error('Explicit choices required');
      if (Object.entries(args.changes).some(([key, value]) => !(key in choices.properties) || typeof value !== 'boolean')) throw Error('Invalid choices');
      result = await controller.configure(args.module, args.changes);
    } else result = await controller[params.name.slice('enhancements_'.length)](args.module);
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  if (Buffer.byteLength(line) > 1024 * 1024) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Message too large' } }); continue; }
  try { const message = JSON.parse(line); if (!message || message.jsonrpc !== '2.0') throw Error('Invalid JSON-RPC'); await handle(message); }
  catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC input' } }); }
}
