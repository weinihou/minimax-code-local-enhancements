import { createState, advancePeriod, recordBalance, configureSession, getEligibleResumes, cancelResume } from './core.mjs';
import { captureOf, sameCapture, nextReset } from './lib.mjs';
const liveTasks = s => (s.tasks || []).filter(t => [0, 1, 2].includes(t.status));
const errorText = e => String(e?.message || e).slice(0, 500);
export class GuardEngine {
  constructor({ state, call, save, now = Date.now }) {
    this.state = state || { engine: createState(now()), processed: [], lastFreshAt: null, scope: null };
    this.call = call; this.save = save; this.now = now;
    this.nextSample = 0;
  }
  item(id) { return this.state.engine.sessions.find(s => s.sessionId === id); }
  async persist() { this.state.updatedAt = this.now(); await this.save(this.state); }
  async sample() {
    const read = await this.call('credits');
    if (!read || !Number.isFinite(read.balance) || read.balance < 0 || !Number.isFinite(read.fetchedAt)
      || this.now() - read.fetchedAt > 30000 || read.fetchedAt > this.now() + 5000 || !read.scope) throw Error('积分读数无效或过期');
    if (this.state.scope && this.state.scope !== read.scope) {
      for (const s of this.state.engine.sessions) { s.enabled = false; s.budgetPause = null; s.error = '登录账号已变化，请重新开启限额'; }
      this.state.engine.balanceBaseline = null;
    }
    this.state.scope = read.scope;
    this.state.engine = recordBalance(this.state.engine, { balance: read.balance }, this.now()).state;
    this.state.lastFreshAt = read.fetchedAt; this.state.creditError = null;
    return read.balance;
  }
  async command(cmd) {
    if (this.state.processed.includes(cmd.id)) { await this.call('ack', cmd.id, { ok: true }); return; }
    try {
      if (cmd.kind === 'configure') {
        const snap = await this.call('snapshot', cmd.sessionId);
        if (snap.archived) throw Error('归档会话不能开启限额');
        if (typeof cmd.enabled !== 'boolean' || !Number.isFinite(cmd.limit) || cmd.limit < 0) throw Error('请输入非负积分限额');
        let balance;
        if (cmd.enabled || this.item(cmd.sessionId)?.enabled) { try { balance = await this.sample(); } catch (e) { this.state.creditError = errorText(e); } }
        this.state.engine = configureSession(this.state.engine, { ...cmd, agentName: snap.agentName, balance }, this.now());
        const item = this.item(cmd.sessionId);
        if (!cmd.enabled) { item.budgetPause = null; item.phase = 'disabled'; }
        else { item.phase = item.budgetPause ? 'paused' : 'active'; item.enabledAt = this.now(); }
      } else if (cmd.kind === 'cancelResume' || cmd.kind === 'watchdogStop') {
        if (this.item(cmd.sessionId)) {
          this.state.engine = cancelResume(this.state.engine, cmd.sessionId, this.now());
          const item = this.item(cmd.sessionId);
          item.phase = 'manual';
          if (cmd.kind === 'watchdogStop') item.error = '监控心跳中断，已保守停止；需手动继续';
        }
      } else throw Error('Unknown guard command');
      this.state.processed = [...this.state.processed.slice(-199), cmd.id];
      await this.persist();
      await this.call('ack', cmd.id, { ok: true });
    } catch (e) { await this.call('ack', cmd.id, { ok: false, error: errorText(e) }); }
  }
  async beginStop(item, snap, reason) {
    item.phase = 'stopping'; item.error = reason === 'stale' ? '积分读数持续不可用，已保守停止' : null;
    item.stopStartedAt = this.now(); item.stopAttemptAt = this.now();
    item.budgetPause = { ownership: 'budget', periodKey: this.state.engine.periodKey,
      resumeAllowed: true, resumeEligible: false, capture: null, reason };
    await this.persist();
    try {
      const result = await this.call('stop', item.sessionId);
      if (result === false || result?.accepted === false || result?.success === false) throw Error('完整停止请求未被接受');
    } catch (e) { item.error = errorText(e); }
  }
  async observe(item) {
    const snap = await this.call('snapshot', item.sessionId);
    if (snap.archived) { item.enabled = false; item.budgetPause = null; item.phase = 'disabled'; return; }
    if (item.phase === 'stopping' || item.phase === 'stop-error') {
      if (!snap.running && !liveTasks(snap).length && (!snap.goal || snap.goal.status !== 'active')) {
        item.phase = 'paused'; item.budgetPause.capture = captureOf(snap);
        if ((snap.tasks || []).some(t => t.stopError)) item.error = '子任务已结束，但曾报告停止错误，请留意结果';
        await this.persist();
      } else if (this.now() - item.stopAttemptAt > 10000) {
        item.stopAttemptAt = this.now();
        if (this.now() - item.stopStartedAt > 60000) { item.phase = 'stop-error'; item.error = '停止仍未完成，正在重试；不能确认子任务已全部停止'; }
        await this.persist(); await this.call('stop', item.sessionId);
      }
      return;
    }
    if (item.phase === 'resuming') {
      // A persisted claim is never replayed after a crash.
      item.phase = snap.running || snap.goal?.status === 'active' ? 'active' : 'manual';
      if (item.phase === 'manual') item.error = '续跑未启动或已结束；请手动确认';
      return;
    }
    const pause = item.budgetPause;
    if (pause?.ownership === 'budget' && pause.capture) {
      if (snap.running || snap.waiting || !sameCapture(pause.capture, captureOf(snap))
        || (snap.goal && snap.goal.status !== 'paused')) {
        this.state.engine = cancelResume(this.state.engine, item.sessionId, this.now());
        this.item(item.sessionId).phase = 'manual';
        return;
      }
      if (getEligibleResumes(this.state.engine).some(s => s.sessionId === item.sessionId)
        && this.state.lastFreshAt && this.now() - this.state.lastFreshAt <= 60000) {
        if (!snap.goal && snap.continuation !== 1) { pause.resumeAllowed = false; item.phase = 'manual'; item.error = '历史状态不可续跑，已取消自动恢复'; return; }
        const capture = pause.capture;
        pause.resumeAllowed = false; item.phase = 'resuming'; item.resumeClaimedAt = this.now();
        await this.persist();
        const result = await this.call('resume', item.sessionId, capture);
        item.budgetPause = null;
        const accepted = result === true || result?.started === true || result?.ok === true;
        item.phase = accepted ? 'active' : 'manual';
        item.error = accepted ? null : (result?.error || result?.reason || '续跑未启动，请手动确认');
        await this.persist();
      }
      return;
    }
    const reached = item.spent > 0 && item.spent >= item.limit;
    const stale = this.now() - (this.state.lastFreshAt || item.enabledAt || 0) > 60000;
    if ((reached || stale) && (snap.running || liveTasks(snap).length || snap.goal?.status === 'active')) {
      if (snap.waiting) { item.error = '会话正在等待确认，未自动恢复或接管'; return; }
      await this.beginStop(item, snap, stale ? 'stale' : 'budget');
    }
  }
  async tick() {
    this.state.engine = advancePeriod(this.state.engine, this.now()).state;
    const commands = await this.call('drain');
    for (const command of commands || []) await this.command(command);
    const managed = this.state.engine.sessions.some(s => s.enabled);
    if (managed && this.now() >= this.nextSample) {
      this.nextSample = this.now() + 15000;
      try { await this.sample(); } catch (e) { this.state.creditError = errorText(e); }
    }
    for (const id of this.state.engine.sessions.filter(s => s.enabled).map(s => s.sessionId)) {
      const item = this.item(id);
      try { await this.observe(item); } catch (e) { item.error = errorText(e); }
    }
    await this.persist();
    const records = Object.fromEntries(this.state.engine.sessions.map(s => [s.sessionId, {
      ...s, spent: Math.round(s.spent * 1000) / 1000, nextReset: nextReset(this.now()),
      phase: s.phase === 'stop-error' ? 'error' : s.phase,
      error: s.error || (s.enabled ? this.state.creditError : null),
    }]));
    await this.call('view', records);
  }
}
