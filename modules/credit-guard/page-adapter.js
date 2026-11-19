(() => {
  'use strict';
  if (window.__CREDIT_GUARD_PAGE__?.version === 2) return;
  window.__CREDIT_GUARD_PAGE__?.dispose();

  let req = window.__QB_QUOTA__?.req;
  if (!req) {
    const chunk = window.webpackChunk_N_E;
    if (!chunk?.push) throw new Error('Runtime module loader unavailable');
    chunk.push([['credit_guard_' + crypto.randomUUID()], {}, runtime => { req = runtime; }]);
  }
  if (typeof req !== 'function') throw new Error('Runtime module capture failed');
  const client = req(76599).u('local');
  const originals = Object.create(null);
  const wrappers = Object.create(null);
  const pending = new Map();
  const continuing = new Set();
  const commands = [];
  const results = Object.create(null);
  let disposed = false;
  let currentScope = null;
  let currentIdentity = null;
  let lastHeartbeat = Date.now();
  let watchedRecords = {};
  let watchdogBusy = false;
  const watchdogStopped = new Set();
  const previousBridge = window.__CREDIT_GUARD_BRIDGE__;

  function active() {
    if (disposed) throw new Error('Credit guard adapter disposed');
  }

  function sessionId(value) {
    if (typeof value !== 'string' || !value) throw new TypeError('sessionId is required');
    return value;
  }

  function enqueue(kind, fields) {
    active();
    const command = { id: crypto.randomUUID(), kind, ...fields };
    commands.push(command);
    return command;
  }

  function manualId(args) {
    const input = args[0];
    if (typeof input === 'string') return input;
    return input?.id || input?.sessionId || input?.session?.sessionId;
  }

  for (const name of ['abortSession', 'patchGoal', 'sendMessage', 'continueTurn',
    'resumeSession', 'enqueueMessage', 'deleteSession', 'updateSession']) {
    if (typeof client[name] !== 'function') continue;
    originals[name] = client[name];
    const wrapper = function (...args) {
      const id = manualId(args);
      if (!disposed && typeof id === 'string' && id) enqueue('cancelResume', { sessionId: id });
      return Reflect.apply(originals[name], this, args);
    };
    wrappers[name] = wrapper;
    client[name] = wrapper;
  }

  function call(name, input) {
    const method = originals[name] || client[name];
    if (typeof method !== 'function') throw new Error('Runtime method unavailable: ' + name);
    return Reflect.apply(method, client, [input]);
  }

  function goalView(goal) {
    if (!goal) return null;
    const statuses = { 1: 'active', 2: 'paused', 3: 'blocked', 4: 'complete' };
    return {
      goalId: goal.goalId ?? goal.id ?? null,
      status: statuses[goal.status] ?? goal.status ?? null,
      updatedAt: goal.updatedAt ?? null,
      statusReason: goal.statusReason ?? null
    };
  }

  function continuationValue(response) {
    const value = response?.continuation?.status ?? response?.continuation?.state
      ?? response?.continuation ?? response?.status ?? response?.state ?? response;
    const raw = typeof value === 'object' ? value?.statusType : value;
    if ([0, 1, 2, 3].includes(raw)) return raw;
    return { unavailable: 0, available: 1, running: 2, waiting: 3 }[raw] ?? 0;
  }

  async function snapshot(id) {
    active();
    sessionId(id);
    const [sessionResult, goalResult, messageResult, taskResult, continuationResult, permissionResult, activity] = await Promise.all([
      call('getSession', { id }),
      call('getGoal', { sessionId: id }),
      call('getMessages', { id, limit: 1, toolResultInlineBytes: 0 }),
      call('listBackgroundTasks', { sessionId: id }),
      call('inspectTurnContinuation', { id }),
      call('listPendingPermissions', {}),
      call('getSessionActivity', { id })
    ]);
    active();
    const session = sessionResult?.session;
    if (!session || session.sessionId !== id) throw new Error('Session not found');
    let goal = goalResult?.goal;
    const goalStore = req(88247).Q;
    if (typeof goalStore?.getBySession === 'function') {
      const normalized = await goalStore.getBySession(id, 'local');
      if (normalized) goal = normalized.goal ?? normalized;
    }
    const continuation = continuationValue(continuationResult);
    const tasks = (taskResult?.items || []).map(task => ({
      taskId: task.taskId,
      status: task.status,
      stopError: task.stopError ?? null,
      ownerSessionId: task.ownerSessionId ?? null
    }));
    if (![0, 1, 2, 3].includes(activity?.state) || typeof activity.truncated !== 'boolean'
      || !Array.isArray(activity.items)) throw new Error('Session tree activity unavailable');
    const statuses = { queued: 0, running: 1, stopping: 2 };
    for (const item of activity.items.filter(item => item.kind === 3)) {
      if (!tasks.some(task => task.taskId === item.refId)) tasks.push({
        taskId: item.refId, status: statuses[item.status] ?? 1,
        stopError: null, ownerSessionId: item.sessionId
      });
    }
    const messages = messageResult?.messages || [];
    const last = messages.find(message => message.msgId === messageResult?.lastMsgId)
      || messages[messages.length - 1];
    return {
      sessionId: id,
      agentName: session.agentName,
      archived: Boolean(session.archived),
      running: session.status?.statusType === 1 || continuation === 2
        || activity.state === 1 || activity.truncated
        || tasks.some(task => [0, 1, 2].includes(task.status)),
      waiting: continuation === 3 || activity.items.some(item => [9, 10].includes(item.kind))
        || (permissionResult?.requests || []).some(item => item.sessionId === id),
      activity,
      continuation,
      goal: goalView(goal),
      updatedAt: session.updatedAt ?? null,
      lastMsgId: messageResult?.lastMsgId ?? last?.msgId ?? null,
      turnId: last?.turnId ?? null,
      tasks
    };
  }

  function clearAccountState() {
    currentScope = null;
    lastHeartbeat = Date.now();
    watchedRecords = {};
    watchdogStopped.clear();
    commands.splice(0);
    for (const key of Object.keys(results)) delete results[key];
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Account changed'));
    }
    pending.clear();
    window.__CREDIT_GUARD_UI__?.update({});
  }

  function identity() {
    const state = req(45255).xL.getState();
    if (!state.isLogin || !state.isAuthReady) throw new Error('Account not ready');
    const user = state.userInfo ?? state.user ?? state.currentUser;
    const id = state.realUserID ?? state.userID ?? state.userId ?? user?.userID ?? user?.userId ?? user?.id;
    if (id == null || String(id) === '') throw new Error('Account identity unavailable');
    return String(id);
  }

  async function scopeFor(id) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('credit-guard:v1:' + id));
    return 'account:' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function credits() {
    active();
    let before;
    try { before = identity(); }
    catch (error) {
      if (currentIdentity !== null || currentScope !== null) clearAccountState();
      currentIdentity = null;
      throw error;
    }
    if (currentIdentity !== before) {
      if (currentIdentity !== null) clearAccountState();
      currentIdentity = before;
    }
    const [response, scope] = await Promise.all([
      req(11557).Eu(undefined, { showToast: false }), scopeFor(before)
    ]);
    active();
    if (identity() !== before || currentIdentity !== before) {
      clearAccountState();
      throw new Error('Account changed during credit read');
    }
    const summary = response?.op_credit_summary ?? response?.data?.op_credit_summary;
    if (!summary) throw new Error('Credit summary unavailable');
    const amount = value => {
      if ((typeof value !== 'number' && typeof value !== 'string')
        || (typeof value === 'string' && !value.trim())) throw new Error('Invalid credit balance');
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) throw new Error('Invalid credit balance');
      return number;
    };
    const total = summary.total_remaining_amount;
    const balance = total == null
      ? amount(summary.purchased_remaining_amount) + amount(summary.free_remaining_amount)
      : amount(total);
    if (!Number.isFinite(balance)) throw new Error('Invalid credit balance');
    currentScope = scope;
    return { balance, fetchedAt: Date.now(), scope };
  }

  async function stop(id) {
    active();
    const state = await snapshot(id);
    active();
    const result = await call('abortSession', { id, reason: 'user_stop' });
    return { accepted: result !== false && result?.accepted !== false && result?.success !== false };
  }

  function matches(state, capture) {
    return capture && ['updatedAt', 'lastMsgId', 'goalId', 'goalUpdatedAt'].every(key =>
      Object.prototype.hasOwnProperty.call(capture, key))
      && capture.updatedAt === state.updatedAt && capture.lastMsgId === state.lastMsgId
      && capture.goalId === (state.goal?.goalId ?? null)
      && capture.goalUpdatedAt === (state.goal?.updatedAt ?? null);
  }

  async function resume(id, capture) {
    active();
    sessionId(id);
    if (continuing.has(id)) return { started: false, reason: 'already-starting' };
    continuing.add(id);
    let background = false;
    try {
      const state = await snapshot(id);
      active();
      if (!matches(state, capture)) return { started: false, reason: 'capture-changed' };
      if (state.archived || state.waiting || state.running) return { started: false, reason: 'session-unavailable' };
      if (state.goal) {
        if (state.goal.status !== 'paused' || !state.goal.goalId) return { started: false, reason: 'goal-not-paused' };
        const store = req(88247).Q;
        if (typeof store?.patch !== 'function') throw new Error('Goal patch helper unavailable');
        if (client.patchGoal !== wrappers.patchGoal || !originals.patchGoal) {
          throw new Error('Goal client hook changed; refusing automatic resume');
        }
        let operation;
        // The helper dispatches synchronously; restore the hook before awaiting its response.
        client.patchGoal = originals.patchGoal;
        try {
          operation = store.patch(id, { status: 'active', expectedGoalId: state.goal.goalId,
            expectedUpdatedAt: state.goal.updatedAt }, 'local');
        } finally {
          if (client.patchGoal === originals.patchGoal) client.patchGoal = wrappers.patchGoal;
        }
        await operation;
        return { started: true, kind: 'goal' };
      }
      if (state.continuation !== 1) return { started: false, reason: 'continuation-unavailable' };
      const stream = call('continueTurn', { id });
      background = true;
      void (async () => {
        try {
          const transport = await stream;
          const iterable = transport?.frames ?? transport;
          if (!iterable?.[Symbol.asyncIterator]) throw new Error('Continuation stream unavailable');
          try { for await (const ignored of iterable) {} }
          finally { transport?.close?.(); await transport?.closed?.catch(() => {}); }
        } catch (error) {
          api.lastError = { sessionId: id, message: error?.message || String(error), at: Date.now() };
        } finally { continuing.delete(id); }
      })();
      return { started: true, kind: 'continuation' };
    } finally {
      if (!background) continuing.delete(id);
    }
  }

  const bridge = {
    configure(input) {
      try {
        active();
        const id = sessionId(input?.sessionId);
        if (typeof input.enabled !== 'boolean' || !Number.isFinite(input.limit) || input.limit < 0) {
          throw new TypeError('Invalid credit guard configuration');
        }
        const command = enqueue('configure', { sessionId: id, enabled: input.enabled, limit: input.limit });
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(command.id);
            reject(new Error('Credit guard acknowledgement timed out; configuration remains queued'));
          }, 30000);
          pending.set(command.id, { resolve, reject, timer });
        });
      } catch (error) { return Promise.reject(error); }
    },
    cancelResume(id) {
      return enqueue('cancelResume', { sessionId: sessionId(typeof id === 'object' ? id?.sessionId : id) });
    }
  };

  const watchdog = setInterval(async () => {
    if (disposed || watchdogBusy || Date.now() - lastHeartbeat <= 90000) return;
    watchdogBusy = true;
    try {
      const enabled = Array.isArray(watchedRecords) ? watchedRecords
        : Object.entries(watchedRecords).map(([id, record]) => ({ ...record, sessionId: id }));
      for (const record of enabled) {
        if (disposed || Date.now() - lastHeartbeat <= 90000) break;
        const id = record.sessionId;
        if (!record.enabled || !id || watchdogStopped.has(id)) continue;
        try {
          const state = await snapshot(id);
          if (disposed || Date.now() - lastHeartbeat <= 90000) break;
          if (!state.running) continue;
          watchdogStopped.add(id);
          enqueue('watchdogStop', { sessionId: id });
          api.lastError = { sessionId: id, message: 'Monitor heartbeat lost; safety stop requested', at: Date.now() };
          const result = await stop(id);
          if (!result.accepted) throw new Error('Safety stop was not accepted');
        } catch (error) {
          watchdogStopped.delete(id);
          if (!disposed) api.lastError = { sessionId: id, message: error?.message || String(error), at: Date.now() };
        }
      }
    } finally { watchdogBusy = false; }
  }, 5000);

  const api = {
    version: 2, commands, results, lastError: null,
    view(records) {
      active();
      lastHeartbeat = Date.now();
      watchedRecords = records && typeof records === 'object' ? records : {};
      watchdogStopped.clear();
      window.__CREDIT_GUARD_UI__?.update(records);
    },
    drain() { active(); return commands.map(command => ({ ...command })); },
    ack(id, result) {
      active();
      const index = commands.findIndex(command => command.id === id);
      if (index === -1) return false;
      commands.splice(index, 1);
      results[id] = result;
      const waiter = pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(id);
        waiter.resolve(result);
      }
      return true;
    },
    snapshot, credits, stop, resume,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdog);
      watchedRecords = {};
      for (const [name, wrapper] of Object.entries(wrappers)) {
        if (client[name] === wrapper) client[name] = originals[name];
      }
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Credit guard adapter disposed'));
      }
      pending.clear();
      commands.splice(0);
      for (const key of Object.keys(results)) delete results[key];
      window.__CREDIT_GUARD_UI__?.dispose();
      if (window.__CREDIT_GUARD_BRIDGE__ === bridge) {
        if (previousBridge === undefined) delete window.__CREDIT_GUARD_BRIDGE__;
        else window.__CREDIT_GUARD_BRIDGE__ = previousBridge;
      }
      if (window.__CREDIT_GUARD_PAGE__ === api) delete window.__CREDIT_GUARD_PAGE__;
    }
  };
  window.__CREDIT_GUARD_PAGE__ = api;
  window.__CREDIT_GUARD_BRIDGE__ = bridge;
})();
