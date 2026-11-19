(() => {
  'use strict';

  window.__CREDIT_GUARD_UI__?.dispose();
  const ROW = '[data-session-id]:has([data-shortcut-session-target])';
  const OWNER = 'data-credit-guard-ui';
  const nodes = new Set();
  const cleanups = [];
  let records = Object.create(null);
  let disposed = false;
  let timer = null;
  let target = null;
  let dialog = null;
  let dialogCleanup = null;
  let previousFocus = null;

  function own(node) {
    node.setAttribute(OWNER, '');
    nodes.add(node);
    return node;
  }

  function listen(node, event, handler, options) {
    node.addEventListener(event, handler, options);
    cleanups.push(() => node.removeEventListener(event, handler, options));
  }

  const style = own(document.createElement('style'));
  style.textContent = `
    .credit-guard-shield { display:inline-flex; flex:0 0 14px; width:14px; height:14px;
      align-items:center; justify-content:center; margin-right:0; vertical-align:middle;
      color:#a78bfa; cursor:help; }
    .credit-guard-shield[data-paused="true"] { color:#fbbf24; }
    .credit-guard-shield svg { width:14px; height:14px; display:block; }
    .credit-guard-entry { cursor:pointer; }
    .credit-guard-dialog { position:fixed; z-index:2147483647; box-sizing:border-box;
      width:280px; max-width:calc(100vw - 24px); padding:16px; border:1px solid var(--cg-border);
      border-radius:10px; background:var(--cg-bg); color:var(--cg-fg);
      box-shadow:0 8px 30px #0005; font:13px/1.5 system-ui,sans-serif; color-scheme:var(--cg-scheme); }
    .credit-guard-dialog h3 { font-size:14px; margin:0 0 14px; color:inherit; }
    .credit-guard-dialog label { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
    .credit-guard-dialog input[type="number"] { box-sizing:border-box; width:100%; padding:7px 9px;
      color:inherit; background:var(--cg-field); border:1px solid var(--cg-border); border-radius:6px; }
    .credit-guard-dialog input[type="checkbox"] { accent-color:#8b5cf6; }
    .credit-guard-dialog button { font:inherit; cursor:pointer; color:inherit; background:var(--cg-field);
      border:1px solid var(--cg-border); border-radius:6px; padding:5px 12px; }
    .credit-guard-dialog button:disabled { cursor:wait; opacity:.6; }
    .credit-guard-dialog .credit-guard-save { background:#7c3aed; color:white; border-color:#7c3aed; }
    .credit-guard-presets { display:flex; gap:6px; margin-top:8px; }
    .credit-guard-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
    .credit-guard-error { color:#f59e0b; margin-top:10px; overflow-wrap:anywhere; }
  `;
  (document.head || document.documentElement).append(style);

  function resetText(value) {
    if (value == null || value === '') return '未知';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '未知';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date) + '（北京时间）';
  }

  function syncRows() {
    const active = new Set();
    document.querySelectorAll(ROW).forEach(row => {
      const sessionId = row.getAttribute('data-session-id');
      const record = Object.prototype.hasOwnProperty.call(records, sessionId) ? records[sessionId] : null;
      const button = row.querySelector('button[data-shortcut-session-target], [data-shortcut-session-target]');
      const title = (button || row).querySelector('span.desktop-text-ui-body');
      let shield = row.querySelector('.credit-guard-shield[' + OWNER + ']');
      if (!record || !record.enabled || !title) {
        if (shield) { shield.remove(); nodes.delete(shield); }
        return;
      }
      if (!shield) {
        shield = own(document.createElement('span'));
        shield.className = 'credit-guard-shield';
        shield.setAttribute('role', 'img');
        shield.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path class="credit-guard-pause" d="M10 9v6m4-6v6"/></svg>';
      }
      if (shield.parentNode !== title.parentNode || shield.nextSibling !== title) title.before(shield);
      const paused = ['paused', 'stopping', 'error'].includes(record.phase);
      const pausedValue = String(paused);
      if (shield.dataset.paused !== pausedValue) {
        shield.dataset.paused = pausedValue;
        shield.querySelector('.credit-guard-pause').style.display = paused ? '' : 'none';
      }
      const tooltip = `积分限额：${record.limit ?? 0}\n已消耗：${record.spent ?? 0}\n下次重置：${resetText(record.nextReset)}${record.error ? '\n错误：' + String(record.error) : ''}`;
      if (shield.title !== tooltip) shield.title = tooltip;
      const label = paused ? '积分限额已暂停' : '已启用积分限额';
      if (shield.getAttribute('aria-label') !== label) shield.setAttribute('aria-label', label);
      active.add(shield);
    });
    for (const node of nodes) {
      if (node.classList.contains('credit-guard-shield') && !active.has(node)) {
        node.remove();
        nodes.delete(node);
      }
    }
  }

  function closeDialog() {
    if (!dialog) return;
    dialogCleanup?.();
    dialogCleanup = null;
    nodes.delete(dialog);
    dialog.remove();
    dialog = null;
    if (previousFocus?.isConnected) previousFocus.focus();
    previousFocus = null;
  }

  function themeFrom(source) {
    let bg = '';
    let fg = '';
    for (let node = source; node && node !== document.documentElement; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (!fg) fg = css.color;
      const color = css.backgroundColor;
      if (color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)') { bg = color; break; }
    }
    const darkHint = document.documentElement.classList.contains('dark') ||
      document.documentElement.dataset.theme === 'dark' ||
      getComputedStyle(document.documentElement).colorScheme === 'dark' ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    bg ||= darkHint ? '#202125' : '#ffffff';
    const rgb = bg.match(/[\d.]+/g);
    const dark = rgb && rgb.length >= 3 ? (+rgb[0] * .299 + +rgb[1] * .587 + +rgb[2] * .114) < 140 : darkHint;
    return { bg, fg: fg || (dark ? '#e5e7eb' : '#202124'), dark };
  }

  function openDialog(sessionId, point, theme) {
    closeDialog();
    previousFocus = document.activeElement;
    const record = records[sessionId] || {};
    const form = own(document.createElement('form'));
    dialog = form;
    form.className = 'credit-guard-dialog';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-label', '积分限额');
    form.style.setProperty('--cg-bg', theme.bg);
    form.style.setProperty('--cg-fg', theme.fg);
    form.style.setProperty('--cg-field', theme.dark ? '#ffffff0c' : '#00000005');
    form.style.setProperty('--cg-border', theme.dark ? '#ffffff26' : '#00000026');
    form.style.setProperty('--cg-scheme', theme.dark ? 'dark' : 'light');
    form.innerHTML = '<h3>积分限额</h3><label><input type="checkbox" name="enabled">启用积分限额</label><label for="credit-guard-limit">限额</label><input id="credit-guard-limit" name="limit" aria-label="积分限额" type="number" min="0" step="any" required><div class="credit-guard-presets"><button type="button" data-limit="0">0</button><button type="button" data-limit="100">100</button><button type="button" data-limit="200">200</button></div><div class="credit-guard-error" role="alert" hidden></div><div class="credit-guard-actions"><button type="button" data-cancel>取消</button><button type="submit" class="credit-guard-save">保存</button></div>';
    const enabled = form.elements.namedItem('enabled');
    const limit = form.elements.namedItem('limit');
    enabled.checked = Boolean(record.enabled);
    limit.value = Number.isFinite(Number(record.limit)) && Number(record.limit) >= 0 ? String(record.limit ?? 0) : '0';
    form.querySelectorAll('[data-limit]').forEach(button => {
      button.onclick = () => { limit.value = button.dataset.limit; limit.focus(); };
    });
    form.querySelector('[data-cancel]').onclick = closeDialog;
    form.onsubmit = async event => {
      event.preventDefault();
      const value = Number(limit.value);
      if (!form.reportValidity() || !Number.isFinite(value) || value < 0) return;
      const save = form.querySelector('[type="submit"]');
      if (save.disabled) return;
      const error = form.querySelector('[role="alert"]');
      error.hidden = true;
      save.disabled = true;
      try {
        const bridge = window.__CREDIT_GUARD_BRIDGE__;
        if (typeof bridge?.configure !== 'function') throw new Error('积分限额服务尚未就绪');
        const result = await bridge.configure({ sessionId, enabled: enabled.checked, limit: value });
        if (result === false || result?.ok === false || result?.success === false || result?.error) {
          throw new Error(result?.error || result?.message || '保存失败');
        }
        if (!disposed && dialog === form) closeDialog();
      } catch (cause) {
        if (!disposed && dialog === form) {
          error.textContent = cause?.message || String(cause);
          error.hidden = false;
        }
      } finally { save.disabled = false; }
    };
    (document.body || document.documentElement).append(form);
    form.style.left = Math.max(12, Math.min(point.x, window.innerWidth - form.offsetWidth - 12)) + 'px';
    form.style.top = Math.max(12, Math.min(point.y, window.innerHeight - form.offsetHeight - 12)) + 'px';
    const escape = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDialog(); }
    };
    document.addEventListener('keydown', escape, true);
    dialogCleanup = () => document.removeEventListener('keydown', escape, true);
    limit.focus();
  }

  function syncMenus() {
    const menus = document.querySelectorAll('.ant-dropdown [role="menu"], .ant-dropdown .ant-dropdown-menu');
    const valid = new Set();
    if (target && Date.now() - target.time < 30000) {
      menus.forEach(menu => {
        const dropdown = menu.closest('.ant-dropdown');
        if (dropdown.classList.contains('ant-dropdown-hidden') || !menu.getClientRects().length) return;
        const items = Array.from(menu.querySelectorAll('[role="menuitem"], .ant-dropdown-menu-item'))
          .filter(item => !item.hasAttribute(OWNER));
        const categories = [/重命名|rename/i, /归档|archive/i, /删除|delete/i];
        if (categories.filter(pattern => items.some(item => pattern.test(item.textContent))).length < 2) return;
        valid.add(menu);
        let entry = menu.querySelector('.credit-guard-entry[' + OWNER + ']');
        if (!entry) {
          entry = own(document.createElement('li'));
          entry.className = 'ant-dropdown-menu-item credit-guard-entry';
          entry.setAttribute('role', 'menuitem');
          entry.tabIndex = -1;
          entry.textContent = '积分限额…';
          const activate = event => {
            event.preventDefault();
            event.stopPropagation();
            const current = target;
            if (!current) return;
            const theme = themeFrom(menu);
            entry.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            entry.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            openDialog(current.sessionId, current, theme);
          };
          entry.onclick = activate;
          entry.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') activate(event); };
        }
        const feedback = items.find(item => /问题反馈|意见反馈|feedback/i.test(item.textContent));
        if (feedback) {
          if (entry.nextSibling !== feedback || entry.parentNode !== feedback.parentNode) feedback.before(entry);
        } else if (entry.parentNode !== menu) menu.append(entry);
      });
    }
    for (const node of nodes) {
      if (node.classList.contains('credit-guard-entry') && !valid.has(node.closest('[role="menu"], .ant-dropdown-menu'))) {
        node.remove(); nodes.delete(node);
      }
    }
  }

  function schedule() {
    if (disposed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (!disposed) { syncRows(); syncMenus(); }
    }, 40);
  }

  listen(document, 'pointerdown', event => {
    const row = event.target instanceof Element ? event.target.closest(ROW) : null;
    if (row) target = { sessionId: row.getAttribute('data-session-id'), x: event.clientX, y: event.clientY, time: Date.now() };
    schedule();
  }, true);
  listen(document, 'contextmenu', event => {
    const row = event.target instanceof Element ? event.target.closest(ROW) : null;
    target = row ? { sessionId: row.getAttribute('data-session-id'), x: event.clientX, y: event.clientY, time: Date.now() } : null;
    schedule();
  }, true);
  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ['class', 'style', 'data-session-id']
  });
  const api = {
    update(nextRecords) {
      if (disposed) return;
      records = nextRecords && typeof nextRecords === 'object' ? nextRecords : Object.create(null);
      schedule();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      closeDialog();
      cleanups.splice(0).forEach(cleanup => cleanup());
      nodes.forEach(node => node.remove());
      nodes.clear();
      records = Object.create(null);
      target = null;
      if (window.__CREDIT_GUARD_UI__ === api) delete window.__CREDIT_GUARD_UI__;
    }
  };
  window.__CREDIT_GUARD_UI__ = api;
  schedule();
})();
