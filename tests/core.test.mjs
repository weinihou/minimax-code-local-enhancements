import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPeriodKey, createState, configureSession, recordBalance, advancePeriod,
  captureBudgetPause, cancelResume, getEligibleResumes, getPauseCandidates, takeBudgetResume,
} from '../modules/credit-guard/core.mjs';

const now = Date.parse('2026-11-18T01:00:00+08:00');
const nextPeriod = Date.parse('2026-11-18T05:00:00+08:00');
const config = (sessionId, extra = {}) => ({ sessionId, agentName: 'worker', enabled: true, limit: 10, ...extra });
const item = (state, id = 'a') => state.sessions.find(item => item.sessionId === id);
const sample = (state, balance, time = now) => recordBalance(state, { balance }, time).state;
const capture = { turnId: 'turn-1', goal: { text: 'opaque' }, updatedAt: 'revision-7', fingerprint: ['x', 1] };

function paused() {
  let state = configureSession(createState(now), config('a'), now);
  state = sample(sample(state, 100), 90);
  return captureBudgetPause(state, 'a', capture, now);
}

test('Beijing boundaries include the four-hour 20:00–00:00 period', () => {
  for (const [time, key] of [
    ['00:00:00', '00'], ['04:59:59', '00'], ['05:00:00', '05'],
    ['09:59:59', '05'], ['10:00:00', '10'], ['14:59:59', '10'],
    ['15:00:00', '15'], ['19:59:59', '15'], ['20:00:00', '20'], ['23:59:59', '20'],
  ]) {
    assert.equal(getPeriodKey(Date.parse(`2026-11-18T${time}+08:00`)), `2026-11-18T${key}:00+08:00`);
  }
  assert.equal(getPeriodKey(new Date('2026-11-18T16:00:00Z')), '2026-11-19T00:00+08:00');
});

test('first sample establishes baseline; each decrease is charged to all enabled sessions', () => {
  let state = configureSession(createState(now), config('a'), now);
  state = configureSession(state, config('b', { limit: 20 }), now);
  state = configureSession(state, config('c', { enabled: false }), now);
  state = sample(state, 100);
  assert.equal(item(state).spent, 0);
  state = sample(state, 94);
  state = sample(state, 110);
  assert.equal(item(state).spent, 6);
  state = sample(state, 103);
  assert.equal(item(state).spent, 13);
  assert.equal(item(state, 'b').spent, 13);
  assert.equal(item(state, 'c').spent, 0);
  assert.deepEqual(getPauseCandidates(state).map(item => item.sessionId), ['a']);
});

test('zero limit triggers only after positive spending', () => {
  let state = configureSession(createState(now), config('a', { limit: 0 }), now);
  assert.deepEqual(getPauseCandidates(state), []);
  state = sample(sample(state, 100), 100);
  assert.deepEqual(getPauseCandidates(state), []);
  state = sample(state, 99.5);
  assert.equal(getPauseCandidates(state).length, 1);
});

test('configuration with a fresh balance settles old membership before toggling', () => {
  let state = configureSession(createState(now), config('a', { balance: 100 }), now);
  state = configureSession(state, config('b', { balance: 94 }), now);
  assert.equal(item(state).spent, 6);
  assert.equal(item(state, 'b').spent, 0);
  state = configureSession(state, config('a', { enabled: false, balance: 90 }), now);
  assert.equal(item(state).spent, 10);
  state = configureSession(state, config('a', { balance: 80, limit: 2 }), now);
  assert.equal(item(state).spent, 10);
  assert.equal(item(state, 'b').spent, 14);
  state = configureSession(state, config('a', { limit: 100 }), now);
  assert.equal(item(state).spent, 10);
});

test('stale and missing readings do not fabricate a zero balance or change baseline', () => {
  let state = configureSession(createState(now), config('a'), now);
  state = recordBalance(state, { stale: true }, now).state;
  assert.equal(state.balanceBaseline, null);
  state = sample(state, 100);
  state = recordBalance(state, { balance: 0, stale: true }, now).state;
  assert.equal(state.balanceBaseline, 100);
  assert.equal(item(state).spent, 0);
  state = sample(state, 96);
  assert.equal(item(state).spent, 4);
  assert.throws(() => recordBalance(state, {}, now), /balance/);
});

test('rollover clears counters including disabled sessions and discards spanning delta', () => {
  let state = paused();
  state = configureSession(state, config('a', { enabled: false }), now);
  state = recordBalance(state, { stale: true }, nextPeriod).state;
  assert.equal(item(state).spent, 0);
  assert.equal(state.balanceBaseline, null);
  assert.equal(item(state).periodKey, getPeriodKey(nextPeriod));
  state = sample(state, 60, nextPeriod);
  state = configureSession(state, config('a'), nextPeriod);
  state = sample(state, 57, nextPeriod);
  assert.equal(item(state).spent, 3);
});

test('budget pause capture survives JSON persistence and rollover only offers eligibility', () => {
  const original = paused();
  const restored = JSON.parse(JSON.stringify(original));
  assert.deepEqual(restored, original);
  assert.equal(takeBudgetResume(restored, 'a', capture, now).resume, null);
  const { state, eligible } = advancePeriod(restored, nextPeriod);
  assert.equal(eligible.length, 1);
  assert.deepEqual(item(state).budgetPause.capture, capture);
  assert.equal(item(state).budgetPause.ownership, 'budget');
  assert.equal(item(original).spent, 10);
  assert.equal(item(original).budgetPause.resumeEligible, false);
  const reordered = { fingerprint: ['x', 1], updatedAt: 'revision-7', goal: { text: 'opaque' }, turnId: 'turn-1' };
  const result = takeBudgetResume(state, 'a', reordered, nextPeriod);
  assert.deepEqual(result.resume.capture, capture);
  assert.equal(item(result.state).budgetPause, null);
  assert.equal(takeBudgetResume(result.state, 'a', capture, nextPeriod).resume, null);
});

test('manual takeover permanently removes resume eligibility across periods', () => {
  let state = cancelResume(paused(), 'a', now);
  state = advancePeriod(state, nextPeriod).state;
  assert.deepEqual(getEligibleResumes(state), []);
  assert.equal(item(state).budgetPause.ownership, 'manual');
  assert.equal(takeBudgetResume(state, 'a', capture, nextPeriod).resume, null);
});

test('disabled sessions cannot resume and changed capture cancels budget ownership', () => {
  const state = configureSession(paused(), config('a', { enabled: false }), nextPeriod);
  assert.deepEqual(getEligibleResumes(state), []);
  assert.equal(takeBudgetResume(state, 'a', capture, nextPeriod).resume, null);
  const enabled = configureSession(state, config('a'), nextPeriod);
  assert.equal(getEligibleResumes(enabled).length, 1);
  const result = takeBudgetResume(enabled, 'a', { ...capture, updatedAt: 'changed' }, nextPeriod);
  assert.equal(result.resume, null);
  assert.equal(result.reason, 'capture-changed');
  assert.equal(item(result.state).budgetPause.resumeAllowed, false);
});

test('invalid limits fail and pause ownership cannot be captured prematurely or overwritten', () => {
  for (const limit of [-1, NaN, Infinity, '1']) {
    assert.throws(() => configureSession(createState(now), config('a', { limit }), now), /limit/);
  }
  const state = configureSession(createState(now), config('a'), now);
  assert.throws(() => captureBudgetPause(state, 'a', capture, now), /budget/);
  assert.throws(() => captureBudgetPause(paused(), 'a', capture, now), /already/);
});
