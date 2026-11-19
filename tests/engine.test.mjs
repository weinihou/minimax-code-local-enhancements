import test from 'node:test';
import assert from 'node:assert/strict';
import { GuardEngine } from '../modules/credit-guard/engine.mjs';
function fixture() {
  let now = Date.parse('2026-11-17T01:59:00Z');
  let balance = 1000, unavailable = false, stopCalls = 0, resumeCalls = 0;
  let commands = [{ id: 'configure1', kind: 'configure', sessionId: 'test', enabled: true, limit: 100 }];
  const snapshot = { sessionId: 'test', agentName: 'mavis', archived: false, running: true, waiting: false,
    continuation: 2, updatedAt: 1, lastMsgId: 'msg', goal: null, tasks: [] };
  const saves = [];
  const call = async (method, ...args) => {
    if (method === 'credits') { if (unavailable) throw Error('offline'); return { balance, fetchedAt: now, scope: 'test-account' }; }
    if (method === 'snapshot') return structuredClone(snapshot);
    if (method === 'drain') return commands;
    if (method === 'ack') { commands = commands.filter(x => x.id !== args[0]); return; }
    if (method === 'stop') { stopCalls++; snapshot.running = false; snapshot.continuation = 1; return { accepted: true }; }
    if (method === 'resume') { resumeCalls++; snapshot.running = true; snapshot.continuation = 2; return { started: true }; }
    if (method === 'view') return;
    throw Error(method);
  };
  const engine = new GuardEngine({ call, save: async s => { saves.push(structuredClone(s)); }, now: () => now });
  return { engine, snapshot, saves, call, get now() { return now; },
    step: ms => { now += ms; }, spend: n => { balance -= n; }, offline: () => { unavailable = true; },
    get stops() { return stopCalls; }, get resumes() { return resumeCalls; },
    command: cmd => { commands.push(cmd); } };
}
test('budget stop waits for child tasks, then resumes once in next period', async () => {
  const f = fixture(); await f.engine.tick();
  f.snapshot.tasks = [{ taskId: 'child', status: 1 }];
  f.spend(100); f.step(16000); await f.engine.tick(); assert.equal(f.stops, 1);
  await f.engine.tick(); assert.equal(f.engine.item('test').phase, 'stopping');
  f.snapshot.tasks[0].status = 5; f.step(3000); await f.engine.tick();
  assert.equal(f.engine.item('test').phase, 'paused'); assert.equal(f.resumes, 0);
  f.step(60000); await f.engine.tick(); assert.equal(f.resumes, 1);
  await f.engine.tick(); assert.equal(f.resumes, 1);
  assert(f.saves.some(s => s.engine.sessions[0].phase === 'resuming'));
});
test('user takeover cancels scheduled resume', async () => {
  const f = fixture(); await f.engine.tick(); f.spend(100); f.step(16000); await f.engine.tick(); await f.engine.tick();
  f.command({ id: 'manual', kind: 'cancelResume', sessionId: 'test' }); await f.engine.tick();
  f.step(60000); await f.engine.tick(); assert.equal(f.resumes, 0);
});
test('changed persisted history is not resumed', async () => {
  const f = fixture(); await f.engine.tick(); f.spend(100); f.step(16000); await f.engine.tick(); await f.engine.tick();
  f.snapshot.lastMsgId = 'new-user-message'; f.step(60000); await f.engine.tick(); assert.equal(f.resumes, 0);
});
test('stale credits conservatively stop managed running work', async () => {
  const f = fixture(); await f.engine.tick(); f.offline(); f.step(61000); await f.engine.tick();
  assert.equal(f.stops, 1); assert.equal(f.engine.item('test').budgetPause.reason, 'stale');
});
test('disabling does not start a paused session', async () => {
  const f = fixture(); await f.engine.tick(); f.spend(100); f.step(16000); await f.engine.tick(); await f.engine.tick();
  f.command({ id: 'disable', kind: 'configure', sessionId: 'test', enabled: false, limit: 100 }); await f.engine.tick();
  f.step(60000); await f.engine.tick(); assert.equal(f.resumes, 0); assert.equal(f.engine.item('test').enabled, false);
});
test('crash after persisted resume claim never repeats the start', async () => {
  const f = fixture(); await f.engine.tick();
  const state = structuredClone(f.engine.state);
  state.engine.sessions[0].phase = 'resuming';
  state.engine.sessions[0].budgetPause = { ownership: 'budget', resumeAllowed: false, capture: {}, resumeEligible: true };
  f.snapshot.running = false; f.snapshot.continuation = 1;
  const restarted = new GuardEngine({ state, call: f.call, save: async () => {}, now: () => f.now });
  await restarted.tick(); assert.equal(f.resumes, 0);
});
