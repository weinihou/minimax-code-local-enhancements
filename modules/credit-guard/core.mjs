const HOUR = 3_600_000;
const BEIJING_OFFSET = 8 * HOUR;

function timestamp(now) {
  const value = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(value)) throw new TypeError('now must be a valid timestamp or Date');
  return value;
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function nonnegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number >= 0`);
  }
}

function session(state, sessionId) {
  const item = state.sessions.find(item => item.sessionId === sessionId);
  if (!item) throw new Error(`Unknown session: ${sessionId}`);
  return item;
}

// Fixed UTC+8 boundaries; the final period of each day is only four hours.
export function getPeriodKey(now = Date.now()) {
  const local = new Date(timestamp(now) + BEIJING_OFFSET);
  const hour = Math.floor(local.getUTCHours() / 5) * 5;
  return `${local.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00+08:00`;
}

export function createState(now = Date.now()) {
  return { version: 1, periodKey: getPeriodKey(now), balanceBaseline: null, sessions: [] };
}

export function getEligibleResumes(state) {
  return state.sessions
    .filter(item => item.enabled && item.budgetPause?.ownership === 'budget'
      && item.budgetPause.resumeAllowed && item.budgetPause.resumeEligible)
    .map(item => ({ sessionId: item.sessionId, agentName: item.agentName,
      capture: copy(item.budgetPause.capture) }));
}

export function advancePeriod(state, now = Date.now()) {
  const next = copy(state);
  const periodKey = getPeriodKey(now);
  if (next.periodKey !== periodKey) {
    next.periodKey = periodKey;
    // No sample spans a boundary: unsampled old-period spending is unknowable.
    next.balanceBaseline = null;
    for (const item of next.sessions) {
      item.spent = 0;
      item.periodKey = periodKey;
      if (item.budgetPause) {
        item.budgetPause.resumeEligible = item.budgetPause.ownership === 'budget'
          && item.budgetPause.resumeAllowed && item.budgetPause.periodKey !== periodKey;
      }
    }
  }
  return { state: next, eligible: getEligibleResumes(next) };
}

// Supply a fresh balance when toggling so the preceding interval uses the old enabled set.
export function configureSession(state, { sessionId, agentName, enabled, limit, balance }, now = Date.now()) {
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
  if (typeof agentName !== 'string') throw new TypeError('agentName must be a string');
  if (typeof enabled !== 'boolean') throw new TypeError('enabled must be boolean');
  nonnegative(limit, 'limit');
  const next = balance === undefined ? advancePeriod(state, now).state
    : recordBalance(state, { balance }, now).state;
  let item = next.sessions.find(item => item.sessionId === sessionId);
  if (!item) {
    item = { sessionId, agentName, enabled, limit, spent: 0,
      periodKey: next.periodKey, budgetPause: null };
    next.sessions.push(item);
  } else {
    Object.assign(item, { agentName, enabled, limit });
  }
  return next;
}

export function getPauseCandidates(state) {
  return state.sessions.filter(item => item.enabled && !item.budgetPause
    && item.spent > 0 && item.spent >= item.limit)
    .map(item => ({ sessionId: item.sessionId, agentName: item.agentName,
      limit: item.limit, spent: item.spent, periodKey: item.periodKey }));
}

// stale includes failed/missing reads: their payload must never replace the baseline.
export function recordBalance(state, { balance, stale = false }, now = Date.now()) {
  if (typeof stale !== 'boolean') throw new TypeError('stale must be boolean');
  if (!stale) nonnegative(balance, 'balance');
  const next = advancePeriod(state, now).state;
  if (!stale) {
    if (next.balanceBaseline !== null) {
      const consumed = Math.max(0, next.balanceBaseline - balance);
      for (const item of next.sessions) {
        if (item.enabled) item.spent += consumed;
      }
    }
    next.balanceBaseline = balance;
  }
  return { state: next, pauseCandidates: getPauseCandidates(next) };
}

// capture is opaque JSON, e.g. { turnId, goal, updatedAt, fingerprint }.
export function captureBudgetPause(state, sessionId, capture, now = Date.now()) {
  const next = advancePeriod(state, now).state;
  const item = session(next, sessionId);
  if (!item.enabled || item.spent <= 0 || item.spent < item.limit) {
    throw new Error('Session has not reached its enabled budget');
  }
  if (item.budgetPause) throw new Error('Session already has a pause record');
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) {
    throw new TypeError('capture must be a JSON object');
  }
  item.budgetPause = { ownership: 'budget', periodKey: next.periodKey,
    resumeAllowed: true, resumeEligible: false, capture: copy(capture) };
  return next;
}

export function cancelResume(state, sessionId, now = Date.now()) {
  const next = advancePeriod(state, now).state;
  const item = session(next, sessionId);
  if (item.budgetPause) {
    Object.assign(item.budgetPause, {
      ownership: 'manual', resumeAllowed: false, resumeEligible: false,
    });
  }
  return next;
}

function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

// The caller supplies the current capture for revalidation and performs the actual start.
export function takeBudgetResume(state, sessionId, currentCapture, now = Date.now()) {
  const next = advancePeriod(state, now).state;
  const item = session(next, sessionId);
  const pause = item.budgetPause;
  if (!item.enabled || !pause || pause.ownership !== 'budget'
    || !pause.resumeAllowed || !pause.resumeEligible) {
    return { state: next, resume: null, reason: 'ineligible' };
  }
  if (!sameJson(pause.capture, currentCapture)) {
    return { state: cancelResume(next, sessionId, now), resume: null, reason: 'capture-changed' };
  }
  const resume = { sessionId: item.sessionId, agentName: item.agentName, capture: copy(pause.capture) };
  item.budgetPause = null;
  return { state: next, resume, reason: null };
}
