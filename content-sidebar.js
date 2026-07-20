(function() {
  'use strict';
  if (window.__gitlabToolboxSidebarLoaded) return;
  window.__gitlabToolboxSidebarLoaded = true;

  const PANEL_ID = 'gitlab-toolbox-sidebar';
  const MODAL_ID = 'gitlab-toolbox-modal';

  const SIDEBAR_SELECTORS = [
    '.nav-sidebar',
    'aside.super-sidebar',
    '[data-testid="super-sidebar"]',
    'nav.super-sidebar',
    '#super-sidebar',
    'nav.gl-sidebar-nav',
    '[data-testid="sidebar"]'
  ];

  let pollTimer = null;

  function findSidebar() {
    for (const sel of SIDEBAR_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function getProjectPath() {
    const m = window.location.pathname.match(/^\/(.+?)\/-\//);
    return m ? m[1] : null;
  }

  function buildPanel(isDark) {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = isDark ? 'gl-toolbox-dark' : 'gl-toolbox-light';

    const label = document.createElement('div');
    label.textContent = 'GitLab Toolbox';
    label.className = 'gl-toolbox-label';
    panel.appendChild(label);

    const buttons = [
      { text: 'Sync Labels',    action: 'syncLabels' },
      { text: 'Fix Broken MRs', action: 'fixBrokenMRs' },
      { text: 'Bulk Tags',      action: 'bulkTags' },
      { text: 'Temp Push Access', action: 'tempPush' }
    ];

    buttons.forEach(({ text, action }) => {
      const btn = document.createElement('button');
      btn.textContent = text;
      btn.className = 'gl-toolbox-btn';
      btn.addEventListener('click', () => {
        const projectPath = getProjectPath();
        if (action === 'syncLabels') {
          startSyncLabels();
        } else if (action === 'fixBrokenMRs') {
          if (!projectPath) {
            showModal('Error', '<p>Could not determine project path.</p>');
            return;
          }
          startFixBrokenMRs(projectPath);
        } else if (action === 'bulkTags') {
          chrome.runtime.sendMessage({ action: 'sidebarBulkTags' });
        } else if (action === 'tempPush') {
          if (!projectPath) {
            showModal('Error', '<p>Could not determine project path.</p>');
            return;
          }
          startTempPushAccess(projectPath);
        }
      });
      panel.appendChild(btn);
    });

    return panel;
  }

  // --- Modal ---

  function showModal(title, content) {
    closeModal();
    const overlay = document.createElement('div');
    overlay.id = MODAL_ID;
    overlay.innerHTML = `
      <div class="gl-toolbox-modal-bg"></div>
      <div class="gl-toolbox-modal-body">
        <div class="gl-toolbox-modal-header">
          <span class="gl-toolbox-modal-title">${title}</span>
          <button class="gl-toolbox-modal-close">&times;</button>
        </div>
        <div class="gl-toolbox-modal-content">${content}</div>
      </div>`;
    overlay.querySelector('.gl-toolbox-modal-close').addEventListener('click', closeModal);
    overlay.querySelector('.gl-toolbox-modal-bg').addEventListener('click', closeModal);
    document.body.appendChild(overlay);
    return overlay.querySelector('.gl-toolbox-modal-content');
  }

  function updateModalContent(html) {
    const el = document.querySelector('#' + MODAL_ID + ' .gl-toolbox-modal-content');
    if (el) el.innerHTML = html;
  }

  function closeModal() {
    stopPolling();
    const el = document.getElementById(MODAL_ID);
    if (el) el.remove();
  }

  // --- Sync Labels ---

  function startSyncLabels() {
    showModal('Sync Labels', '<div class="gl-toolbox-spinner"></div><p>Extracting MRs from page...</p>');
    startPolling();
    chrome.runtime.sendMessage({ action: 'sidebarSyncLabels' });
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(async () => {
      const state = await chrome.runtime.sendMessage({ action: 'getSyncState' });
      if (!state) return;
      const done = state.completed || 0;
      const total = state.total || 0;
      const errors = state.results ? state.results.filter(r => !r.success).length : 0;
      if (total > 0) {
        updateModalContent(`
          <div style="margin-bottom:8px">Processing ${done}/${total} MRs${errors ? ` (${errors} errors)` : ''}</div>
          <div class="gl-toolbox-progress-bar"><div class="gl-toolbox-progress-fill" style="width:${Math.round((done/total)*100)}%"></div></div>
          ${state.error ? `<div class="gl-toolbox-error">${state.error}</div>` : ''}`);
      }
      if (!state.running && total > 0) {
        stopPolling();
        const ok = done - errors;
        updateModalContent(`
          <p>Sync complete: ${ok}/${total} successful${errors ? `, ${errors} failed` : ''}.</p>
          ${state.error ? `<div class="gl-toolbox-error">${state.error}</div>` : ''}
          ${state.results && state.results.length ? buildResultTable(state.results) : ''}`);
      }
    }, 600);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function buildResultTable(results) {
    let html = '<table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px"><tr><th style="text-align:left;padding:4px">MR</th><th style="text-align:left;padding:4px">Status</th></tr>';
    for (const r of results.slice(-20)) {
      const mrLabel = r.mrTitle ? r.mrTitle.replace(/</g,'&lt;') : `!${r.mrIid}`;
      const status = r.success ? '<span style="color:#2da44e">OK</span>' : `<span style="color:#cf222e">${(r.error||'Failed').replace(/</g,'&lt;')}</span>`;
      html += `<tr><td style="padding:4px;border-top:1px solid rgba(128,128,128,0.15)">${mrLabel}</td><td style="padding:4px;border-top:1px solid rgba(128,128,128,0.15)">${status}</td></tr>`;
    }
    html += '</table>';
    return html;
  }

  // --- Fix Broken MRs ---

  async function startFixBrokenMRs(projectPath) {
    showModal('Fix Broken MRs', '<div class="gl-toolbox-spinner"></div><p>Scanning MRs for broken references...</p>');
    chrome.runtime.sendMessage({ action: 'sidebarFixBrokenMRs', projectPath });
  }

  // --- Temp Push Access (protected branches) ---

  const PROTECT_BRANCHES = [
    { key: 'main', label: 'main' },
    { key: 'release', label: 'release' },
    { key: 'testing', label: 'testing' }
  ];

  async function loadProtectRows(projectPath) {
    const rows = [];
    for (const b of PROTECT_BRANCHES) {
      try {
        const status = await chrome.runtime.sendMessage({
          action: 'getProtectedPushStatus',
          projectPath,
          branch: b.key
        });
        if (!status) {
          rows.push({ key: b.key, label: b.label, status: { error: 'No response from extension (reload extension).' } });
        } else {
          rows.push({ key: b.key, label: b.label, status });
        }
      } catch (e) {
        rows.push({ key: b.key, label: b.label, status: { error: e.message } });
      }
    }
    return rows;
  }

  async function startTempPushAccess(projectPath, keepMessage) {
    const existing = document.getElementById(MODAL_ID);
    if (!existing) {
      showModal('Temp Push Access', '<div class="gl-toolbox-spinner"></div><p>Loading protected branch status...</p>');
    } else {
      updateModalContent('<div class="gl-toolbox-spinner"></div><p>Loading protected branch status...</p>');
    }
    const rows = await loadProtectRows(projectPath);
    renderTempPushUI(projectPath, rows, keepMessage || '');
  }

  function renderTempPushUI(projectPath, rows, statusMessage) {
    let html = '<p style="margin:0 0 10px;opacity:0.75;font-size:12px">Temporarily allow Maintainers to push, then lock again (No one).</p>';
    html += '<div class="gl-toolbox-protect-list">';
    for (const row of rows) {
      const s = row.status || {};
      if (s.error) {
        html += `<div class="gl-toolbox-protect-row"><span><b>${row.label}</b></span><span class="gl-toolbox-error">${escHtml(s.error)}</span></div>`;
        continue;
      }
      const branchName = s.branch || row.label;
      const ruleHint = s.protectName && s.protectName !== branchName
        ? ` <span style="opacity:0.6;font-size:10px">(rule: ${escHtml(s.protectName)})</span>`
        : '';
      const badge = !s.protected
        ? '<span class="gl-toolbox-badge gl-toolbox-badge--muted">not protected</span>'
        : s.allowPush
          ? '<span class="gl-toolbox-badge gl-toolbox-badge--open">Maintainers can push</span>'
          : '<span class="gl-toolbox-badge gl-toolbox-badge--locked">No one can push</span>';
      const levelHint = s.protected && s.accessLevel != null
        ? ` <span style="opacity:0.5;font-size:10px">lvl ${s.accessLevel}</span>`
        : '';
      const btnLabel = s.allowPush ? 'Lock (No one)' : 'Allow Maintainers';
      const btnClass = s.allowPush ? 'gl-toolbox-protect-btn gl-toolbox-protect-btn--lock' : 'gl-toolbox-protect-btn gl-toolbox-protect-btn--allow';
      html += `<div class="gl-toolbox-protect-row" data-branch-key="${row.key}">
        <div><b>${escHtml(branchName)}</b>${ruleHint} ${badge}${levelHint}</div>
        <button type="button" class="${btnClass}" data-branch="${row.key}" data-allow="${s.allowPush ? '0' : '1'}">${btnLabel}</button>
      </div>`;
    }
    html += '</div><div id="gl-toolbox-protect-status" style="margin-top:10px;font-size:12px">';
    if (statusMessage) html += escHtml(statusMessage);
    html += '</div>';
    updateModalContent(html);

    const content = document.querySelector('#' + MODAL_ID + ' .gl-toolbox-modal-content');
    if (!content) return;
    content.querySelectorAll('.gl-toolbox-protect-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const branch = btn.getAttribute('data-branch');
        const allow = btn.getAttribute('data-allow') === '1';
        const statusEl = document.getElementById('gl-toolbox-protect-status');
        content.querySelectorAll('.gl-toolbox-protect-btn').forEach(b => { b.disabled = true; });
        if (statusEl) statusEl.textContent = allow ? 'Allowing Maintainers...' : 'Locking push...';
        try {
          const result = await chrome.runtime.sendMessage({
            action: 'setProtectedPushAccess',
            projectPath,
            branch,
            allow
          });
          if (!result) {
            if (statusEl) statusEl.innerHTML = '<span class="gl-toolbox-error">No response — reload the extension and try again.</span>';
            content.querySelectorAll('.gl-toolbox-protect-btn').forEach(b => { b.disabled = false; });
            return;
          }
          if (result.error) {
            if (statusEl) statusEl.innerHTML = `<span class="gl-toolbox-error">${escHtml(result.error)}</span>`;
            content.querySelectorAll('.gl-toolbox-protect-btn').forEach(b => { b.disabled = false; });
            return;
          }
          await startTempPushAccess(projectPath, result.message || 'Updated.');
        } catch (e) {
          if (statusEl) statusEl.innerHTML = `<span class="gl-toolbox-error">${escHtml(e.message)}</span>`;
          content.querySelectorAll('.gl-toolbox-protect-btn').forEach(b => { b.disabled = false; });
        }
      });
    });
  }

  function escHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // --- Listen for results from background ---

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'sidebarFixResult') {
      updateModalContent(msg.html);
    }
    if (msg.action === 'sidebarSyncError') {
      stopPolling();
      updateModalContent(`<div class="gl-toolbox-error">${msg.message}</div>`);
    }
  });

  // --- Sidebar Injection ---

  function detectDark(element) {
    if (!element) return false;
    const bg = getComputedStyle(element).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return false;
    const luminance = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
    return luminance < 128;
  }

  function injectPanel() {
    if (document.getElementById(PANEL_ID)) return;
    const sidebar = findSidebar();
    if (!sidebar) return;

    const isDark = detectDark(sidebar);
    const panel = buildPanel(isDark);

    const footer = sidebar.querySelector('.super-sidebar-footer');
    if (footer) {
      footer.parentNode.insertBefore(panel, footer);
    } else {
      const inner = sidebar.querySelector('.nav-sidebar-inner-scroll') || sidebar;
      inner.appendChild(panel);
    }
  }

  function tryInject() {
    if (document.getElementById(PANEL_ID)) return;
    const sidebar = findSidebar();
    if (sidebar && sidebar.children.length > 0) {
      injectPanel();
    }
  }

  function observeSPA() {
    const observer = new MutationObserver(tryInject);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function init() {
    const style = document.createElement('style');
    style.textContent = `
      .gl-toolbox-dark {
        color: rgba(255,255,255,0.85);
        border-top-color: rgba(255,255,255,0.12) !important;
      }
      .gl-toolbox-light {
        color: rgba(0,0,0,0.85);
        border-top-color: rgba(0,0,0,0.1) !important;
      }
      #${PANEL_ID} {
        padding: 8px 12px;
        border-top-width: 1px;
        border-top-style: solid;
      }
      .gl-toolbox-label {
        font-size: 11px;
        font-weight: 600;
        opacity: 0.65;
        text-transform: uppercase;
        margin-bottom: 6px;
        letter-spacing: 0.5px;
      }
      .gl-toolbox-btn {
        display: block;
        width: 100%;
        text-align: left;
        padding: 6px 8px;
        margin: 2px 0;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: inherit;
        font-size: 12px;
        cursor: pointer;
        font-family: inherit;
      }
      .gl-toolbox-btn:hover {
        background: rgba(128,128,128,0.18);
      }
      #${MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 100000;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .gl-toolbox-modal-bg {
        position: absolute;
        inset: 0;
        background: rgba(0,0,0,0.35);
      }
      .gl-toolbox-modal-body {
        position: relative;
        background: var(--gl-background-color-default, #fff);
        color: var(--gl-text-color-default, #222);
        border-radius: 8px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.2);
        width: 440px;
        max-width: 90vw;
        max-height: 80vh;
        overflow-y: auto;
      }
      .gl-toolbox-modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 16px;
        border-bottom: 1px solid var(--gl-border-color-default, #dcdee0);
      }
      .gl-toolbox-modal-title {
        font-weight: 600;
        font-size: 14px;
      }
      .gl-toolbox-modal-close {
        background: none;
        border: none;
        font-size: 20px;
        cursor: pointer;
        color: inherit;
        padding: 0;
        line-height: 1;
      }
      .gl-toolbox-modal-content {
        padding: 16px;
        font-size: 13px;
      }
      .gl-toolbox-spinner {
        width: 24px;
        height: 24px;
        border: 3px solid rgba(128,128,128,0.25);
        border-top-color: #6b4fbb;
        border-radius: 50%;
        animation: gl-toolbox-spin 0.6s linear infinite;
        margin: 8px auto;
      }
      @keyframes gl-toolbox-spin { to { transform: rotate(360deg); } }
      .gl-toolbox-progress-bar {
        height: 6px;
        background: rgba(128,128,128,0.15);
        border-radius: 3px;
        overflow: hidden;
      }
      .gl-toolbox-progress-fill {
        height: 100%;
        background: #6b4fbb;
        border-radius: 3px;
        transition: width 0.3s;
      }
      .gl-toolbox-error {
        color: #cf222e;
        margin-top: 8px;
        font-size: 12px;
      }
      .gl-toolbox-protect-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .gl-toolbox-protect-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        border: 1px solid var(--gl-border-color-default, #dcdee0);
        border-radius: 6px;
      }
      .gl-toolbox-protect-btn {
        border: none;
        border-radius: 4px;
        padding: 5px 10px;
        font-size: 11px;
        cursor: pointer;
        font-family: inherit;
        white-space: nowrap;
      }
      .gl-toolbox-protect-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .gl-toolbox-protect-btn--allow {
        background: #2da44e;
        color: #fff;
      }
      .gl-toolbox-protect-btn--lock {
        background: #c62828;
        color: #fff;
      }
      .gl-toolbox-badge {
        display: inline-block;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 10px;
        margin-left: 4px;
        vertical-align: middle;
      }
      .gl-toolbox-badge--open {
        background: rgba(45,164,78,0.15);
        color: #2da44e;
      }
      .gl-toolbox-badge--locked {
        background: rgba(198,40,40,0.12);
        color: #c62828;
      }
      .gl-toolbox-badge--muted {
        background: rgba(128,128,128,0.15);
        color: #666;
      }
    `;
    document.head.appendChild(style);

    tryInject();
    observeSPA();
  }

  if (document.head) {
    init();
  } else {
    new MutationObserver((_, obs) => {
      if (document.head) { obs.disconnect(); init(); }
    }).observe(document.documentElement, { childList: true });
  }
})();
