#!/usr/bin/env node
// quotabar MCP server — 零依赖，NDJSON JSON-RPC over stdio。
//
// 暴露给 agent 的工具（都是原生工具调用，不需要手敲 shell）：
//   quotabar_status   看状态：端口/桌面端/守护/注入/当前数据
//   quotabar_read     读数据：5h 限额、积分、重置卡
//   quotabar_repair   修复：拉起守护 + 立即重注入（不重启桌面端）
//   quotabar_enable   装/更新 launchd 守护
//   quotabar_disable  停守护
//
// 刻意不提供「重启桌面端」：那会掐断正在跑的会话，只能由用户手动做。

import {
  fullStatus, formatStatus, readState, injectOnce, installDaemon, uninstallDaemon,
  daemonInfo, portOpen, appInfo, LABEL, PORT,
} from './quotabar.mjs';

const SERVER_INFO = { name: 'quotabar-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';

function log(msg) {
  process.stderr.write(`[quotabar-mcp] ${msg}\n`);
}

const TOOLS = [
  {
    name: 'quotabar_status',
    description:
      '查看 MiniMax Code 桌面端侧边栏限额条（quotabar）的运行状态：调试端口是否就绪、桌面端是否带调试端口、launchd 守护是否在跑、注入是否生效、当前取到的 5h 限额/积分/重置卡。只读，不做任何修改。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quotabar_read',
    description:
      '读取侧边栏限额条当前显示的数据：5 小时限额剩余百分比、重置时间、积分（付费+赠予，形如「4,687 + 11,952」）、可用重置卡数量。只读，不做任何修改。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quotabar_repair',
    description:
      '修复侧边栏限额条：确保 launchd 守护在跑，并立即重新注入一次页面脚本（幂等，不重启桌面端、不影响当前会话）。若桌面端当前没带 --remote-debugging-port，本工具无法处理——那需要用户手动重启一次桌面端，不能自动做。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quotabar_enable',
    description:
      '安装或更新限额条的 launchd 守护（`com.minimax.quotabar.daemon`），让注入常驻、桌面端重启后自动恢复。只在用户明确要求「装上/常驻/开机自启」时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'quotabar_disable',
    description:
      '停止限额条的 launchd 守护（`com.minimax.quotabar.daemon`）。不影响桌面端本身，只是不再自动注入。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

// ---------- 工具实现 ----------

async function toolStatus() {
  const s = await fullStatus(PORT);
  return formatStatus(s);
}

async function toolRead() {
  const open = await portOpen(PORT);
  if (!open) {
    return '调试端口未就绪：桌面端当前没带 --remote-debugging-port，读不到注入数据。需要用户手动重启一次桌面端。';
  }
  const d = await readState(PORT);
  const lines = [];
  if (d.unlimited) lines.push('5 小时限额：不限额');
  else if (d.remain5 !== null && d.remain5 !== undefined) {
    lines.push(`5 小时限额：剩余 ${d.remain5}%`);
    if (d.reset5) lines.push(`重置：${d.reset5}${d.reset5In ? `（${d.reset5In.replace('后重置', '后')}）` : ''}`);
  }
  lines.push(`积分：${d.credits || '（未取到）'}`);
  lines.push(`可用重置卡：${d.cards === null || d.cards === undefined ? '（未取到）' : `${d.cards} 张`}`);
  lines.push(`数据源：${d.strategy || '-'}｜注入状态：${d.status || '-'}${d.error ? `｜错误：${d.error}` : ''}`);
  return lines.join('\n');
}

async function toolRepair() {
  const app = appInfo();
  const open = await portOpen(PORT);
  if (!open) {
    const why = app.running
      ? '桌面端在运行但没带 --remote-debugging-port=9333'
      : '桌面端没在运行';
    return [
      '无法自动修复：' + why + '。',
      '这一步不能自动做——重启桌面端会掐断正在跑的会话。请请用户手动重启一次桌面端（带 --remote-debugging-port）。',
      '重启后本插件的守护会自动把限额条注入回去（若守护没在跑，可调用 quotabar_enable）。',
    ].join('\n');
  }
  const notes = [];
  const d = daemonInfo();
  if (!d.running) {
    installDaemon();
    notes.push('守护进程之前不在，已重新拉起');
  }
  const r = await injectOnce(PORT);
  if (r && r.ok) {
    notes.push('已重新注入');
    if (r.credits) notes.push(`积分=${r.credits}`);
    if (r.cards !== null && r.cards !== undefined) notes.push(`重置卡=${r.cards} 张`);
    if (r.data && r.data.remain5 !== undefined && r.data.remain5 !== null) notes.push(`5h 剩余=${r.data.remain5}%`);
  } else {
    notes.push('重新注入未成功：' + JSON.stringify(r));
  }
  return notes.join('\n');
}

async function toolEnable() {
  installDaemon();
  const d = daemonInfo();
  return `已安装/更新守护 ${LABEL}：${d.running ? `运行中 pid=${d.pid}` : '提交后稍等一拍再看状态'}。`;
}

async function toolDisable() {
  uninstallDaemon();
  return `已停止守护 ${LABEL}。桌面端本身不受影响。`;
}

const HANDLERS = {
  quotabar_status: toolStatus,
  quotabar_read: toolRead,
  quotabar_repair: toolRepair,
  quotabar_enable: toolEnable,
  quotabar_disable: toolDisable,
};

// ---------- JSON-RPC ----------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;
  if (id === undefined) return;
  switch (method) {
    case 'initialize':
      sendResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
      return;
    case 'tools/list':
      sendResult(id, { tools: [...toolsByName.values()] });
      return;
    case 'tools/call': {
      const name = params?.name;
      const fn = HANDLERS[name];
      if (!fn) return sendError(id, -32601, `Tool not found: ${name}`);
      try {
        const text = await fn(params?.arguments || {});
        sendResult(id, { content: [{ type: 'text', text: String(text) }] });
      } catch (e) {
        sendResult(id, {
          content: [{ type: 'text', text: `执行失败：${e && e.message ? e.message : String(e)}` }],
          isError: true,
        });
      }
      return;
    }
    case 'ping':
      sendResult(id, {});
      return;
    default:
      sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`bad JSON from host: ${e.message}`);
      continue;
    }
    handleMessage(msg).catch((e) => log(`handler error: ${e && e.message ? e.message : e}`));
  }
});
process.stdin.on('end', () => process.exit(0));

log(`registered ${TOOLS.length} tool(s): ${[...toolsByName.keys()].join(', ')}`);
