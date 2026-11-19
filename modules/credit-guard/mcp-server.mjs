import { createInterface } from 'node:readline';
import * as control from './control.mjs';

const tools = [
  { name: 'credit_guard_status', description: '只读查看 macOS 积分限额守护的启用标记、launchd 进程、运行状态摘要和页面适配器版本及错误状态；不读取会话正文或凭据。' },
  { name: 'credit_guard_repair', description: '在 macOS 上启用并幂等请求启动积分限额守护，由守护执行页面注入；保留正在运行的进程，不重启应用或更改系统代理。返回请求状态，不保证注入已经完成。' },
  { name: 'credit_guard_enable', description: '在 macOS 上启用积分限额守护并请求启动；以后会话启动时可自动拉起已启用的守护。不会重启应用，注入完成情况请查询状态。' },
  { name: 'credit_guard_disable', description: '在 macOS 上写入停用标记，请求守护安全完成当前操作、清理 UI 和适配器后退出；不强杀正在停止或恢复会话的进程。' },
].map(tool => ({ ...tool, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }));
const actions = {
  credit_guard_status: control.status,
  credit_guard_repair: control.repair,
  credit_guard_enable: control.enable,
  credit_guard_disable: control.disable,
};
const reply = message => process.stdout.write(JSON.stringify(message) + '\n');
const fail = (id, code, message) => reply({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    fail(null, -32700, 'Invalid JSON');
    return;
  }
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    fail(request?.id ?? null, -32600, 'Invalid request');
    return;
  }
  if (request.id === undefined) return;
  const { id, method, params } = request;
  let result;
  if (method === 'initialize') {
    result = { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'credit-guard', version: '1.0.1' } };
  } else if (method === 'ping') {
    result = {};
  } else if (method === 'tools/list') {
    result = { tools };
  } else if (method === 'tools/call') {
    const action = actions[params?.name];
    if (!action || !Object.hasOwn(actions, params?.name)) {
      fail(id, -32602, 'Unknown tool');
      return;
    }
    if (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments) || Object.keys(params.arguments).length)) {
      fail(id, -32602, '工具不接受参数');
      return;
    }
    try {
      const value = await action();
      result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], ...(value.error ? { isError: true } : {}) };
    } catch {
      result = { isError: true, content: [{ type: 'text', text: '积分限额操作失败：无法读取本地组件或更新守护状态。未输出原始错误，以避免泄露敏感内容。' }] };
    }
  } else {
    fail(id, -32601, 'Method not found');
    return;
  }
  reply({ jsonrpc: '2.0', id, result });
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on('line', line => {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > 1024 * 1024) {
    fail(null, -32600, 'Request too large');
    return;
  }
  queue = queue.then(() => handle(line)).catch(() => fail(null, -32603, 'Internal error'));
});
