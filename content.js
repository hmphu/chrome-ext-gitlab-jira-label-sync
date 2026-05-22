(() => {
  const JIRA_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

  function isSingleMRPage() {
    return /\/-\/merge_requests\/\d+/.test(window.location.pathname);
  }

  function extractSingleMR() {
    const iidMatch = window.location.pathname.match(/merge_requests\/(\d+)/);
    if (!iidMatch) return null;

    const titleEl = document.querySelector(
      '.detail-page-header .title, ' +
      '.merge-request-details .title, ' +
      '[data-testid="title-content"], ' +
      '.page-title, ' +
      '.title-container .title, ' +
      '.issue-title-text, ' +
      'h2.gl-font-size-h-display'
    );
    const title = titleEl ? titleEl.textContent.trim() : '';
    const match = title ? title.match(JIRA_PATTERN) : null;

    return {
      title: title || `MR !${iidMatch[1]}`,
      jiraTicket: match ? match[0] : null,
      mrIid: iidMatch[1],
      mrUrl: window.location.pathname,
      needsResolve: !match
    };
  }

  function extractMergeRequests() {
    if (isSingleMRPage()) {
      const mr = extractSingleMR();
      return mr ? [mr] : [];
    }

    const mrRows = document.querySelectorAll('.merge-request');
    const results = [];

    mrRows.forEach(row => {
      const titleEl = row.querySelector('.merge-request-title-text a, .js-prefetch-document');
      if (!titleEl) return;

      const title = titleEl.textContent.trim();
      const match = title.match(JIRA_PATTERN);
      const mrLink = titleEl.getAttribute('href');
      const iidMatch = mrLink ? mrLink.match(/merge_requests\/(\d+)/) : null;

      results.push({
        title,
        jiraTicket: match ? match[0] : null,
        mrIid: iidMatch ? iidMatch[1] : null,
        mrUrl: mrLink
      });
    });

    return results;
  }

  function getProjectPath() {
    const pathMatch = window.location.pathname.match(/^\/(.+?)\/-\/merge_requests/);
    return pathMatch ? pathMatch[1] : null;
  }

  function autoSend() {
    const mrs = extractMergeRequests();
    const projectPath = getProjectPath();
    if (mrs.length > 0 && projectPath) {
      chrome.runtime.sendMessage({ action: 'addMRs', data: { mrs, projectPath } }).catch(() => {});
    }
  }

  function extractJiraTicketIds() {
    const ids = new Set();
    const globalPattern = /[A-Z][A-Z0-9]+-\d+/g;

    const mr = extractSingleMR();
    if (mr && mr.jiraTicket) ids.add(mr.jiraTicket);

    document.querySelectorAll('.commit-row-message, .commits-list .item-title, [data-testid="commit-row-description"], .commit-content .item-title a, .commit .commit-title, .js-toggle-content .commit-row-message').forEach(el => {
      const matches = el.textContent.match(globalPattern);
      if (matches) matches.forEach(m => ids.add(m));
    });

    const branchEl = document.querySelector('.ref-container .ref-name, [data-testid="ref-name"], .js-source-branch');
    if (branchEl) {
      const matches = branchEl.textContent.match(globalPattern);
      if (matches) matches.forEach(m => ids.add(m));
    }

    return [...ids];
  }

  function injectJiraPanel(tickets) {
    let overlay = document.getElementById('jira-ticket-overlay');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'jira-ticket-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.4);z-index:99999;display:flex;align-items:center;justify-content:center';
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    const panel = document.createElement('div');
    panel.style.cssText = 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:13px;background:#fff;border-radius:10px;max-width:500px;width:90%;max-height:70vh;box-shadow:0 8px 32px rgba(0,0,0,0.2);line-height:1.5;display:flex;flex-direction:column;overflow:hidden';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:14px 20px;border-bottom:1px solid #e0e0e0;flex-shrink:0';
    header.innerHTML = '<span style="font-weight:600;font-size:14px;color:#172b4d">Jira Tickets</span>';
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'background:none;border:none;font-size:18px;cursor:pointer;color:#6b778c;padding:0 4px';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const content = document.createElement('div');
    content.style.cssText = 'padding:12px 20px;overflow-y:auto;flex:1';

    if (tickets === null) {
      content.innerHTML = '<div style="text-align:center;padding:20px;color:#6b778c"><div style="margin-bottom:8px;font-size:20px">⏳</div>Fetching Jira tickets...</div>';
      panel.appendChild(content);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      return;
    }

    if (tickets.length === 0) {
      content.innerHTML = '<div style="color:#6b778c;font-style:italic">No Jira tickets found in commits</div>';
    } else {
      content.innerHTML = tickets.map(t => {
        if (t.error) return `<div style="color:#c62828;margin-bottom:8px">⚠ ${t.key || ''}: ${t.error}</div>`;
        const ticketUrl = t.jiraBaseUrl ? `${t.jiraBaseUrl.replace(/\/$/, '')}/browse/${t.key}` : '#';
        const labelsHtml = (t.labels || []).map(l => `<span style="display:inline-block;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px">${l}</span>`).join('');
        const parentHtml = t.parent ? `<div style="font-size:11px;color:#6b778c;margin-top:4px;padding:4px 6px;background:#f9f9f9;border-radius:4px">↑ <a href="${t.jiraBaseUrl ? t.jiraBaseUrl.replace(/\/$/, '') + '/browse/' + t.parent.key : '#'}" target="_blank" style="color:#0052CC;text-decoration:none;font-weight:500">${t.parent.key}</a> <span style="background:#dfe1e6;color:#42526e;padding:0 4px;border-radius:2px;font-size:10px">${t.parent.status}</span> ${t.parent.title} · 👤 ${t.parent.assignee || 'Unassigned'}</div>` : '';
        return `<div style="padding:8px 0;border-bottom:1px solid #f0f0f0">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <a href="${ticketUrl}" target="_blank" style="font-weight:600;color:#0052CC;text-decoration:none">${t.key}</a>
            <span style="background:#dfe1e6;color:#42526e;padding:1px 6px;border-radius:3px;font-size:11px;font-weight:500">${t.status || 'Unknown'}</span>
          </div>
          <div style="margin-bottom:3px;color:#172b4d">${t.title || ''}</div>
          <div style="font-size:12px;color:#6b778c">👤 ${t.assignee || 'Unassigned'}</div>
          ${labelsHtml ? `<div style="margin-top:4px">${labelsHtml}</div>` : ''}
          ${parentHtml}
        </div>`;
      }).join('');
    }

    panel.appendChild(content);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMRs') {
      const mrs = extractMergeRequests();
      const projectPath = getProjectPath();
      sendResponse({ mrs, projectPath, url: window.location.href });
    }
    if (request.action === 'showJiraPanel') {
      const ticketIds = extractJiraTicketIds();
      if (ticketIds.length === 0) {
        injectJiraPanel([]);
        sendResponse({ ok: true });
        return;
      }
      injectJiraPanel(null);
      chrome.storage.sync.get({ jiraBaseUrl: '' }, (settings) => {
        let completed = 0;
        const results = [];
        ticketIds.forEach(ticketId => {
          chrome.runtime.sendMessage({ action: 'getJiraTicketDetails', ticketId }, (response) => {
            if (response) response.jiraBaseUrl = settings.jiraBaseUrl;
            results.push(response || { key: ticketId, error: 'No response' });
            completed++;
            if (completed === ticketIds.length) {
              injectJiraPanel(results);
            }
          });
        });
      });
      sendResponse({ ok: true });
    }
    return true;
  });

  autoSend();
})();
