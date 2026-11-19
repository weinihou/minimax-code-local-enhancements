// 注入到 MiniMax Code 渲染进程：侧边栏底部的 5hr 限额条
// 由 injector.mjs 通过 CDP Runtime.evaluate 反复执行，需保证幂等
(() => {
  const KEY = '__QB_QUOTA__';
  const S = window[KEY] || (window[KEY] = {});
  const API_QUOTA = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
  const API_CARDS = 'https://www.minimaxi.com/backend/account/reset_card/list?page=1&size=200';
  const ACCENT = 'var(--border_accent, #0094fc)';
  const TRACK = 'color-mix(in srgb, var(--text_default_primary, #171717) 13%, transparent)';

  S.polls = (S.polls || 0) + 1;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // 与应用内一致：已用% = 100 - 剩余%；上限% = boost_permille / 10（缺省 100）
  const usedPercent = (e) =>
    typeof e === 'number' && Number.isFinite(e) ? clamp(Math.round(100 - e), 0, 100) : null;
  const capPercent = (e) => (typeof e === 'number' && Number.isFinite(e) ? e / 10 : 100);

  function fmtTime(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = typeof v === 'number' ? new Date(v > 1e12 ? v : v * 1000) : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function fmtDur(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`;
  }

  function fmtDay(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function normalize(data) {
    const list = Array.isArray(data) ? data : data && Array.isArray(data.model_remains) ? data.model_remains : [];
    if (!list.length) return null;
    const isVideo = (m) => m && /video/i.test(m.model_name || '');
    const m =
      list.find((x) => x && x.model_name === 'general') ||
      list.find((x) => x && !isVideo(x)) ||
      list[0];
    if (!m) return null;
    const countEntry = list.find(
      (x) => x && isVideo(x) && typeof x.current_interval_total_count === 'number' && x.current_interval_total_count > 0,
    );
    return {
      remain5: typeof m.current_interval_remaining_percent === 'number' ? m.current_interval_remaining_percent : null,
      used5: usedPercent(m.current_interval_remaining_percent),
      cap5: capPercent(m.interval_boost_permille),
      reset5: fmtTime(m.end_time),
      reset5In: fmtDur(m.remains_time),
      remainWeek: typeof m.current_weekly_remaining_percent === 'number' ? m.current_weekly_remaining_percent : null,
      weekUnlimited: m.current_weekly_status === 3,
      countTotal: countEntry ? countEntry.current_interval_total_count : null,
      countUsed: countEntry ? countEntry.current_interval_usage_count : null,
      unlimited: m.current_interval_status === 3,
    };
  }

  async function fetchQuota() {
    const api = window.electronAPI;
    if (!api || typeof api.proxyFetch !== 'function') {
      S.lastError = 'no-proxyFetch';
      return null;
    }
    try {
      const r = await api.proxyFetch({ url: API_QUOTA, method: 'GET', headers: {} });
      S.httpStatus = r ? r.status : null;
      if (r && r.ok && r.data) {
        S.strategy = 'proxyFetch';
        const n = normalize(r.data);
        if (n) return n;
        S.lastError = 'normalize-failed';
      } else {
        S.lastError = 'http-' + (r ? r.status : 'null');
      }
    } catch (e) {
      S.lastError = 'proxy-throw:' + String(e);
    }
    return null;
  }

  // 重置卡：服务端 cards 里按到期时间过滤掉已失效的
  async function fetchCards() {
    const api = window.electronAPI;
    if (!api || typeof api.proxyFetch !== 'function') return null;
    try {
      const r = await api.proxyFetch({ url: API_CARDS, method: 'GET', headers: {} });
      if (!r || !r.ok || !r.data) return null;
      const list = Array.isArray(r.data.cards) ? r.data.cards : [];
      const now = Date.now();
      const alive = list.filter((c) => c && (!c.expire_time || c.expire_time > now));
      let earliest = null;
      for (const c of alive) {
        const t = c.expire_time;
        if (typeof t === 'number' && (earliest === null || t < earliest)) earliest = t;
      }
      return { count: alive.length, earliest };
    } catch (e) {
      return null;
    }
  }

  // ---------- 积分：复用应用自己的 store 与格式化 ----------
  // 应用已把「付费积分 + 赠予积分」算好存在 usageQuota.creditSummary，
  // 这里只借用它的两个模块：格式器（iH/ry）和 store。
  function resolveApp() {
    if (!S.app) S.app = { fmt: null, store: null };
    if (S.app.fmt && S.app.store) return S.app;
    const now = Date.now();
    if (S.appScanAt && now - S.appScanAt < 20000) return S.app;
    S.appScanAt = now;
    const g = self.webpackChunk_N_E;
    if (!g || typeof g.push !== 'function') return S.app;
    if (!S.req) {
      try {
        g.push([[0], {}, (r) => { S.req = r; }]);
      } catch (e) { /* 拿不到 require 就放弃 */ }
    }
    const req = S.req;
    if (!req || !req.m) return S.app;
    for (const id in req.m) {
      let src;
      try { src = String(req.m[id]); } catch (e) { continue; }
      let ex = null;
      if (!S.app.fmt && src.includes('purchased_remaining_amount')) {
        try { ex = req(id); } catch (e) { ex = null; }
        if (ex && typeof ex.iH === 'function' && typeof ex.ry === 'function') S.app.fmt = ex;
      }
      if (!S.app.store && src.includes('creditSummary:')) {
        try { ex = ex || req(id); } catch (e) { ex = null; }
        if (ex && typeof ex === 'object') {
          for (const k in ex) {
            const v = ex[k];
            if (v && (typeof v === 'object' || typeof v === 'function') && typeof v.getState === 'function') {
              S.app.store = v;
              break;
            }
          }
        }
      }
      if (S.app.fmt && S.app.store) break;
    }
    return S.app;
  }

  // 与应用内同口径：只取整数部分，千分位；赠予积分为 0 时不显示 "+ 0"
  function localInt(v) {
    if (v === null || v === undefined || v === '') return '0';
    const m = /^(\d+)(?:\.(\d+))?$/.exec(String(v).replace(/,/g, '').trim());
    const int = m ? m[1].replace(/^0+(?=\d)/, '') : '0';
    return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function localCredits(purchased, free) {
    const a = localInt(purchased);
    const b = localInt(free);
    return b === '0' ? a : `${a} + ${b}`;
  }

  function readCredits() {
    const app = resolveApp();
    if (!app.store) return null;
    let st = null;
    try { st = app.store.getState(); } catch (e) { return null; }
    if (!st) return null;
    const cs =
      (st.usageQuota && st.usageQuota.creditSummary) ||
      st.creditSummary ||
      (st.membershipInfo && st.membershipInfo.op_credit_summary) ||
      null;
    if (!cs) return null;
    const purchased = cs.purchased_remaining_amount ?? cs.purchased_credit;
    const free = cs.free_remaining_amount ?? cs.free_credit;
    if (purchased === undefined && free === undefined) return null;
    const text = app.fmt
      ? app.fmt.iH(purchased ?? 0, free ?? 0)
      : localCredits(purchased ?? 0, free ?? 0);
    return { text };
  }

  // 借应用自己的刷新动作保持积分新鲜，5 分钟一次
  function refreshAppUsage() {
    const app = resolveApp();
    if (!app.store) return;
    let st = null;
    try { st = app.store.getState(); } catch (e) { return; }
    const fn = st && st.refreshUsageQuota;
    if (typeof fn !== 'function') return;
    const now = Date.now();
    if (S.appRefreshAt && now - S.appRefreshAt < 300000) return;
    S.appRefreshAt = now;
    try { fn({ silent: true, source: 'quotabar' }); } catch (e) { /* 忽略 */ }
  }

  // ---------- DOM ----------
  function findTrigger() {
    return document.querySelector('[data-testid="sidebar-user-menu-trigger"]');
  }

  function findNameSpan(trigger) {
    const byClass = trigger.querySelector('span.desktop-text-ui-body');
    if (byClass) return byClass;
    const spans = Array.from(trigger.querySelectorAll('span')).filter((s) => s.textContent && s.textContent.trim());
    spans.sort((a, b) => a.textContent.trim().length - b.textContent.trim().length);
    return spans[0] || null;
  }

  // span 在纵向 flex 容器里会被拉伸，量到的是列宽；用 Range 量文字实际宽度
  function textRect(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      const r = range.getBoundingClientRect();
      if (r.width > 0) return r;
    } catch (e) { /* 退化到元素盒子 */ }
    return el.getBoundingClientRect();
  }

  const CSS = `
      #qb-quota-bar{position:absolute;display:flex;align-items:center;gap:6px;height:16px;
        font-family:inherit;pointer-events:auto;z-index:20;white-space:nowrap}
      #qb-quota-bar .qb-track{width:72px;height:6px;border-radius:999px;overflow:hidden;
        background:${TRACK}}
      #qb-quota-bar .qb-fill{height:100%;border-radius:999px;background:${ACCENT};
        transition:width .35s ease;min-width:0}
      #qb-quota-bar .qb-text{font-size:10px;line-height:1;letter-spacing:.2px;
        color:var(--text_default_tertiary, #adadad)}
      #qb-quota-tip{position:fixed;z-index:2147483000;width:max-content;min-width:196px;max-width:260px;
        padding:10px 12px;border-radius:12px;background:var(--bg_default_primary, #fff);
        border:1px solid var(--border_default, rgba(0,0,0,.08));
        box-shadow:0 10px 30px rgba(0,0,0,.16);opacity:0;visibility:hidden;
        transition:opacity .12s ease, visibility 0s linear .12s;pointer-events:none;
        font-size:11px;line-height:1.55;color:var(--text_default_primary, #171717)}
      #qb-quota-tip[data-show="1"]{opacity:1;visibility:visible;transition:opacity .12s ease}
      #qb-quota-tip .qb-row{display:flex;justify-content:space-between;gap:16px}
      #qb-quota-tip .qb-row+.qb-row{margin-top:4px}
      #qb-quota-tip .qb-k{color:var(--text_default_tertiary, #adadad)}
      #qb-quota-tip .qb-v{font-weight:500;text-align:right}
      #qb-quota-tip .qb-hint{margin-top:7px;padding-top:7px;
        border-top:1px solid var(--border_light, rgba(0,0,0,.06));
        color:var(--text_default_tertiary, #adadad);font-size:10px}
    `;

  function ensureStyles() {
    let style = document.getElementById('qb-quota-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'qb-quota-style';
      document.head.appendChild(style);
    }
    if (style.textContent !== CSS) style.textContent = CSS;
  }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = 'qb-quota-bar';
    const track = document.createElement('div');
    track.className = 'qb-track';
    const fill = document.createElement('div');
    fill.className = 'qb-fill';
    track.appendChild(fill);
    const text = document.createElement('div');
    text.className = 'qb-text';
    text.textContent = '—';
    bar.append(track, text);
    bar.addEventListener('mouseenter', () => { S.hoverUntil = Date.now() + 800; syncTip(); });
    bar.addEventListener('mouseleave', () => { S.hoverUntil = 0; syncTip(); });
    return { bar, fill, text };
  }

  function ensureTip() {
    let tip = document.getElementById('qb-quota-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'qb-quota-tip';
      document.body.appendChild(tip);
    }
    return tip;
  }

  // 显隐只认「指针是否真在条上」：:hover 由真实指针驱动，合成事件不会让它成立，
  // 所以不会再出现卡片被置为显示后卡住不消失。
  function barHovered() {
    const bar = document.getElementById('qb-quota-bar');
    if (!bar || !bar.isConnected) return false;
    if (S.hoverUntil && Date.now() < S.hoverUntil) return true;
    try { return bar.matches(':hover'); } catch (e) { return false; }
  }

  function syncTip() {
    const tip = document.getElementById('qb-quota-tip');
    if (!tip) return;
    if (barHovered()) {
      positionTip();
      tip.setAttribute('data-show', '1');
    } else {
      // 立即收回，不靠 setTimeout：后台窗口里定时器会被节流，收不回来
      tip.removeAttribute('data-show');
    }
  }

  function positionTip() {
    const bar = document.getElementById('qb-quota-bar');
    const tip = document.getElementById('qb-quota-tip');
    if (!bar || !tip) return;
    const br = bar.getBoundingClientRect();
    const tw = tip.offsetWidth || 196;
    const th = tip.offsetHeight || 120;
    let left = br.right - tw;
    if (left < 8) left = 8;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    let top = br.top - th - 8;
    if (top < 8) top = br.bottom + 8;
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function renderTip(tip, q, credits, cards) {
    const row = (k, v) => `<div class="qb-row"><span class="qb-k">${k}</span><span class="qb-v">${v}</span></div>`;
    let html = '';
    if (!q) {
      html += row('状态', S.lastError ? `取数失败（${S.lastError}）` : '取数中…');
    } else if (q.unlimited) {
      html += row('5 小时周期', '不限额');
    } else {
      html += row('5 小时剩余', `${q.remain5}%`);
      const resetTxt = q.reset5 ? (q.reset5In ? `${q.reset5}（${q.reset5In.replace('后重置', '后')}）` : q.reset5) : q.reset5In || '—';
      html += row('重置', resetTxt);
    }
    if (credits && credits.text) html += row('积分', credits.text);
    if (cards) {
      const day = cards.earliest ? fmtDay(cards.earliest) : null;
      html += row('重置卡', cards.count ? `${cards.count} 张${day ? `（最早 ${day} 到期）` : ''}` : '0 张');
    }
    html += `<div class="qb-hint">数据源 ${S.strategy || '-'} · 30 秒刷新</div>`;
    tip.innerHTML = html;
  }

  function layout() {
    const trigger = findTrigger();
    if (!trigger) {
      S.status = 'no-trigger';
      return null;
    }
    const nameSpan = findNameSpan(trigger);
    if (!nameSpan) {
      S.status = 'no-name-span';
      return null;
    }
    const host = trigger.parentElement || trigger;
    if (getComputedStyle(host).position === 'static') {
      host.dataset.qbOrigPos = host.style.position || '';
      host.style.position = 'relative';
    }

    ensureStyles();
    const prevHover = barHovered();
    let bar = document.getElementById('qb-quota-bar');
    if (!bar || !bar.isConnected) {
      // 重建时保住悬停态，否则指针没动也会突然收起
      const built = buildBar();
      bar = built.bar;
      host.appendChild(bar);
      S.fill = built.fill;
      S.text = built.text;
      if (prevHover) S.hoverUntil = Date.now() + 1000;
    } else if (bar.parentElement !== host) {
      host.appendChild(bar);
    }
    if (!S.fill || !S.fill.isConnected) {
      S.fill = bar.querySelector('.qb-fill');
      S.text = bar.querySelector('.qb-text');
    }

    const nameRect = textRect(nameSpan);
    const actions = trigger.querySelector('[data-testid="sidebar-footer-actions"]');
    const rightLimit = actions ? actions.getBoundingClientRect().left : host.getBoundingClientRect().right - 40;
    const usable = rightLimit - 8 - nameRect.right;
    if (usable < 44) {
      bar.style.display = 'none';
      S.status = 'too-narrow';
      S.usable = Math.round(usable);
      return null;
    }
    const showText = usable >= 86;
    const barWidth = Math.max(36, Math.min(96, usable - (showText ? 30 : 0)));
    bar.style.display = 'flex';
    const hb = host.getBoundingClientRect();
    bar.style.left = Math.round(nameRect.right - hb.left + 8) + 'px';
    bar.style.top = Math.round(nameRect.top - hb.top + (nameRect.height - 16) / 2) + 'px';
    const track = bar.querySelector('.qb-track');
    if (track) track.style.width = Math.round(barWidth) + 'px';
    if (S.text) S.text.style.display = showText ? 'block' : 'none';
    S.usable = Math.round(usable);
    S.barWidth = barWidth;
    return { bar };
  }

  async function refresh() {
    const laid = layout();
    if (!laid) {
      syncTip();
      return;
    }
    if (S.status === 'ok' && S.last && Date.now() - (S.lastFetchAt || 0) < 20000) {
      S.skipped = true;
      syncTip();
      return;
    }
    S.skipped = false;
    S.lastFetchAt = Date.now();
    const [q, cards] = await Promise.all([fetchQuota(), fetchCards()]);
    const credits = readCredits();
    refreshAppUsage();
    const tip = ensureTip();
    if (!q) {
      S.status = 'no-data';
      if (S.text) S.text.textContent = '—';
      if (S.fill) S.fill.style.width = '0%';
    } else {
      S.status = 'ok';
      S.last = q;
      S.lastError = null;
      const remain = q.unlimited ? 100 : clamp(q.remain5 === null ? 0 : q.remain5, 0, 100);
      if (S.fill) S.fill.style.width = remain + '%';
      if (S.text) S.text.textContent = q.unlimited ? '不限' : remain + '%';
    }
    S.credits = credits;
    S.cards = cards;
    renderTip(tip, q, credits, cards);
    positionTip();
    syncTip();
  }

  if (!S.timer) {
    S.timer = setInterval(() => { refresh().catch(() => {}); }, 60000);
  }
  if (!S.obs) {
    S.obs = new MutationObserver(() => {
      if (S.layoutTimer) return;
      S.layoutTimer = setTimeout(() => {
        S.layoutTimer = null;
        layout();
        positionTip();
        syncTip();
      }, 150);
    });
    S.obs.observe(document.body, { childList: true, subtree: true });
  }
  if (!S.onResize) {
    S.onResize = () => { refresh().catch(() => {}); };
    window.addEventListener('resize', S.onResize);
  }
  if (!S.onMove) {
    // 不用 rAF 节流：窗口被遮挡时 rAF 不会触发，同步逻辑会整体停摆
    S.onMove = () => {
      const now = Date.now();
      if (S.moveAt && now - S.moveAt < 60) return;
      S.moveAt = now;
      syncTip();
    };
    document.addEventListener('mousemove', S.onMove, { passive: true, capture: true });
    document.addEventListener('mouseleave', S.onMove, { passive: true, capture: true });
    window.addEventListener('blur', S.onMove);
  }
  if (!S.hoverTimer) {
    // 兜底：切回窗口时指针可能已在条上，此时不会有 mousemove，靠轮询纠正
    S.hoverTimer = setInterval(syncTip, 1000);
  }

  return refresh()
    .then(() => ({
      ok: S.status === 'ok',
      status: S.status,
      strategy: S.strategy || null,
      data: S.last || null,
      credits: S.credits ? S.credits.text : null,
      cards: S.cards ? S.cards.count : null,
      error: S.lastError || null,
    }))
    .catch((e) => ({ ok: false, status: 'throw', error: String(e) }));
})()
