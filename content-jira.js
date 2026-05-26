(() => {
  let lastTicketId = null;

  function getJiraTicketId() {
    const breadcrumb = document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
    if (breadcrumb) return breadcrumb.textContent.trim();

    const match = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (match) return match[1];

    const params = new URLSearchParams(window.location.search);
    const selected = params.get('selectedIssue');
    if (selected && /^[A-Z][A-Z0-9]+-\d+$/.test(selected)) return selected;

    const key = document.querySelector('#key-val, .issue-header-content .key');
    if (key) return key.textContent.trim();

    return null;
  }

  function autoSend() {
    const ticketId = getJiraTicketId();
    if (ticketId) {
      chrome.runtime.sendMessage({ action: 'jiraPageDetected', ticketId }).catch(() => {});
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getJiraTicket') {
      sendResponse({ ticketId: getJiraTicketId() });
    }
    return true;
  });

  function checkParentSync() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkParentStatus', ticketId }, (response) => {
      if (!response || !response.hasParent) return;
      if (response.parentStatus.toUpperCase() !== 'DONE') return;
      if (response.childStatus.toUpperCase() === response.parentStatus.toUpperCase()) return;

      const sync = confirm(
        `Parent ticket ${response.parentKey} status is "${response.parentStatus}".\n` +
        `Current ticket status is "${response.childStatus}".\n\n` +
        `Do you want to sync this ticket's status to "${response.parentStatus}"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionChild',
          ticketId,
          targetStatus: response.parentStatus
        }, (res) => {
          if (res && res.success) {
            location.reload();
          } else {
            alert(`Failed to transition: ${res && res.error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  function checkSubtasksSync() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkSubtasksStatus', ticketId }, (response) => {
      if (!response || response.error) return;
      if (response.currentStatus.toUpperCase() !== 'DONE') return;
      if (!response.pendingSubtasks || response.pendingSubtasks.length === 0) return;

      const list = response.pendingSubtasks.map(s => `  • ${s.key} (${s.status})`).join('\n');
      const sync = confirm(
        `This ticket is "DONE" but ${response.pendingSubtasks.length} subtask(s) are not:\n${list}\n\n` +
        `Do you want to set all subtasks to "DONE"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionSubtasks',
          subtaskKeys: response.pendingSubtasks.map(s => s.key),
          targetStatus: 'Done'
        }, (res) => {
          if (res && res.results) {
            const failed = res.results.filter(r => r.error);
            if (failed.length === 0) {
              location.reload();
            } else {
              alert(`Some transitions failed:\n${failed.map(f => `${f.key}: ${f.error}`).join('\n')}`);
            }
          }
        });
      }
    });
  }

  function checkAllChildrenDone() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkSubtasksStatus', ticketId }, (response) => {
      if (!response || response.error) return;
      if (response.currentStatus.toUpperCase() === 'DONE') return;
      if (!response.totalSubtasks || response.totalSubtasks === 0) return;
      if (response.pendingSubtasks && response.pendingSubtasks.length > 0) return;

      const sync = confirm(
        `All subtasks are "DONE" but this ticket is "${response.currentStatus}".\n\n` +
        `Do you want to set this ticket to "DONE"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionChild',
          ticketId,
          targetStatus: 'Done'
        }, (res) => {
          if (res && res.success) {
            location.reload();
          } else {
            alert(`Failed to transition: ${res && res.error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  function injectStyles() {
    if (document.getElementById('gl-mr-panel-styles')) return;
    const style = document.createElement('style');
    style.id = 'gl-mr-panel-styles';
    style.textContent = `
      #gl-mr-panel{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:12px;background:#fff;border:1px solid #dfe1e6;border-radius:8px;padding:12px;margin-bottom:12px}
      #gl-mr-panel .gl-mr-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}
      #gl-mr-panel .gl-mr-toggle{font-size:10px;color:#888}
      #gl-mr-panel .gl-mr-title{font-size:13px;font-weight:600;color:#6b4fbb;display:flex;align-items:center;gap:6px}
      #gl-mr-panel .gl-mr-refresh{background:none;border:none;cursor:pointer;color:#6b4fbb;font-size:14px;padding:2px 4px;border-radius:4px}
      #gl-mr-panel .gl-mr-refresh:hover{background:#f3e8fd}
      #gl-mr-panel .gl-mr-status{font-size:11px;color:#666;margin-bottom:8px}
      #gl-mr-panel .gl-mr-item{padding:6px 8px;border:1px solid #e0e0e0;border-radius:4px;margin-bottom:4px}
      #gl-mr-panel .gl-mr-item.merged{border-left:3px solid #4caf50}
      #gl-mr-panel .gl-mr-item.opened{border-left:3px solid #1565c0}
      #gl-mr-panel .gl-mr-item.closed{border-left:3px solid #f44336}
      #gl-mr-panel .gl-mr-item a{color:#1565c0;text-decoration:none;font-weight:500;font-size:11px}
      #gl-mr-panel .gl-mr-item a:hover{text-decoration:underline}
      #gl-mr-panel .gl-mr-branches{font-size:10px;color:#555;margin-top:2px}
      #gl-mr-panel .gl-mr-branches code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:10px}
      #gl-mr-panel .gl-mr-state{display:inline-block;padding:1px 5px;border-radius:3px;font-size:10px;font-weight:500;margin-top:3px}
      #gl-mr-panel .gl-mr-state.merged{background:#e8f5e9;color:#2e7d32}
      #gl-mr-panel .gl-mr-state.opened{background:#e3f2fd;color:#1565c0}
      #gl-mr-panel .gl-mr-state.closed{background:#fdecea;color:#c62828}
      #gl-mr-panel .gl-mr-section{font-size:11px;font-weight:600;color:#6b4fbb;padding:3px 6px;margin:6px 0 4px;background:#f3e8fd;border-radius:3px}
      #gl-mr-panel .gl-mr-empty{font-size:11px;color:#999;font-style:italic}
      #gl-mr-panel .gl-mr-project{font-size:9px;color:#888;margin-top:2px}
      #gl-mr-panel .gl-mr-env{display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;font-weight:700;margin-left:4px;vertical-align:middle}
      #gl-mr-panel .gl-mr-env.prod{background:#fdecea;color:#c62828}
      #gl-mr-panel .gl-mr-env.uat{background:#fff3e0;color:#e65100}
      #gl-mr-panel .gl-mr-env.dev{background:#e3f2fd;color:#1565c0}
      #gl-mr-panel .gl-mr-filter-row{display:flex;gap:4px;margin-bottom:8px}
      #gl-mr-panel .gl-mr-filter{flex:1;padding:4px 6px;border:1px solid #d0c8f0;border-radius:4px;font-size:11px;background:#faf8ff;color:#333}
      #gl-mr-panel .gl-mr-related-header{font-size:11px;font-weight:600;color:#1565c0;padding:4px 6px;margin:8px 0 4px;background:#e3f2fd;border-radius:3px}
      #gl-mr-panel .gl-mr-related-section{border-left:3px solid #1565c0;padding-left:4px}
      #gl-mr-panel .gl-mr-related-subtask{margin-left:8px;border-left:2px solid #90caf9;padding-left:4px}
      #gl-mr-panel .gl-mr-link-type{font-size:9px;font-weight:400;background:#bbdefb;padding:1px 4px;border-radius:3px;color:#1565c0;margin:0 2px}
    `;
    document.head.appendChild(style);
  }

  function getOrCreatePanel() {
    let panel = document.getElementById('gl-mr-panel');
    if (panel) return panel;

    injectStyles();
    panel = document.createElement('div');
    panel.id = 'gl-mr-panel';
    panel.innerHTML = `
      <div class="gl-mr-header">
        <span class="gl-mr-title" style="cursor:pointer">
          <span class="gl-mr-toggle">▼</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>
          GitLab MRs
        </span>
        <button class="gl-mr-refresh" title="Refresh">↻</button>
      </div>
      <div class="gl-mr-content">
        <div class="gl-mr-status">Loading...</div>
        <div class="gl-mr-body"></div>
      </div>
    `;
    panel.querySelector('.gl-mr-refresh').addEventListener('click', () => fetchAndRenderMRs(true));
    panel.querySelector('.gl-mr-title').addEventListener('click', () => {
      const content = panel.querySelector('.gl-mr-content');
      const toggle = panel.querySelector('.gl-mr-toggle');
      const collapsed = content.style.display === 'none';
      content.style.display = collapsed ? '' : 'none';
      toggle.textContent = collapsed ? '▼' : '▶';
    });

    const target = document.querySelector('#issue\\.views\\.issue-details\\.issue-layout\\.container-right > div > div:nth-child(2) > div:nth-child(3)');
    if (target) {
      target.parentElement.insertBefore(panel, target);
    } else {
      const sidebar = document.querySelector('[data-testid="issue.views.issue-details.template-detail-view.right-side-panel"]')
        || document.querySelector('[role="complementary"]')
        || document.querySelector('aside');
      if (sidebar) {
        sidebar.prepend(panel);
      } else {
        panel.style.position = 'fixed';
        panel.style.top = '80px';
        panel.style.right = '16px';
        panel.style.width = '280px';
        panel.style.zIndex = '9999';
        panel.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        document.body.appendChild(panel);
      }
    }
    return panel;
  }

  function renderMRPanel(data) {
    const panel = getOrCreatePanel();
    const status = panel.querySelector('.gl-mr-status');
    const body = panel.querySelector('.gl-mr-body');

    if (data.error) {
      status.textContent = data.error;
      body.innerHTML = '';
      return;
    }

    const relatedMRs = (data.related || []).flatMap(rel => [...rel.mrs, ...(rel.subtasks || []).flatMap(relSt => relSt.mrs)]);
    const allMRs = [...(data.mrs || []), ...(data.subtasks || []).flatMap(st => st.mrs), ...relatedMRs];
    status.textContent = allMRs.length === 0
      ? 'No MRs found'
      : `${allMRs.length} MR(s) found`;

    body.innerHTML = '';

    const allTicketIds = [];
    if (data.mrs && data.mrs.length > 0) allTicketIds.push(data.ticketId);
    if (data.subtasks) data.subtasks.forEach(st => { if (st.mrs.length > 0) allTicketIds.push(st.ticketId); });
    if (data.related) data.related.forEach(rel => {
      if (rel.mrs.length > 0) allTicketIds.push(rel.ticketId);
      if (rel.subtasks) rel.subtasks.forEach(relSt => { if (relSt.mrs.length > 0) allTicketIds.push(relSt.ticketId); });
    });
    const states = [...new Set(allMRs.map(mr => mr.state))];

    if (allMRs.length > 0 && (allTicketIds.length > 1 || states.length > 1)) {
      const filterRow = document.createElement('div');
      filterRow.className = 'gl-mr-filter-row';

      if (allTicketIds.length > 1) {
        const tf = document.createElement('select');
        tf.className = 'gl-mr-filter';
        tf.dataset.filterType = 'ticket';
        tf.innerHTML = `<option value="">All tickets</option>` + allTicketIds.map(id => `<option value="${id}">${id}</option>`).join('');
        tf.addEventListener('change', applyFilters);
        filterRow.appendChild(tf);
      }

      if (states.length > 1) {
        const sf = document.createElement('select');
        sf.className = 'gl-mr-filter';
        sf.dataset.filterType = 'state';
        sf.innerHTML = `<option value="">All states</option>` + states.map(s => `<option value="${s}">${s}</option>`).join('');
        sf.addEventListener('change', applyFilters);
        filterRow.appendChild(sf);
      }

      body.appendChild(filterRow);
    }

    if (data.mrs && data.mrs.length > 0) {
      const section = document.createElement('div');
      section.className = 'gl-mr-filter-section';
      section.dataset.ticketId = data.ticketId;
      data.mrs.forEach(mr => section.appendChild(createMRItem(mr)));
      body.appendChild(section);
    }

    if (data.subtasks) {
      data.subtasks.forEach(st => {
        if (st.mrs.length === 0) return;
        const section = document.createElement('div');
        section.className = 'gl-mr-filter-section';
        section.dataset.ticketId = st.ticketId;
        const header = document.createElement('div');
        header.className = 'gl-mr-section';
        header.textContent = `${st.ticketId} — ${st.summary}`;
        section.appendChild(header);
        st.mrs.forEach(mr => section.appendChild(createMRItem(mr)));
        body.appendChild(section);
      });
    }

    if (data.related && data.related.some(rel => rel.mrs.length > 0 || (rel.subtasks || []).some(relSt => relSt.mrs.length > 0))) {
      const relatedHeader = document.createElement('div');
      relatedHeader.className = 'gl-mr-related-header';
      relatedHeader.textContent = 'Related Tickets';
      body.appendChild(relatedHeader);

      data.related.forEach(rel => {
        if (rel.mrs.length === 0 && !(rel.subtasks || []).some(relSt => relSt.mrs.length > 0)) return;
        const section = document.createElement('div');
        section.className = 'gl-mr-filter-section gl-mr-related-section';
        section.dataset.ticketId = rel.ticketId;
        const header = document.createElement('div');
        header.className = 'gl-mr-section';
        header.innerHTML = `${rel.ticketId} <span class="gl-mr-link-type">${rel.linkType}</span> — ${rel.summary}`;
        section.appendChild(header);
        rel.mrs.forEach(mr => section.appendChild(createMRItem(mr)));

        if (rel.subtasks) {
          rel.subtasks.forEach(relSt => {
            if (relSt.mrs.length === 0) return;
            const subSection = document.createElement('div');
            subSection.className = 'gl-mr-filter-section gl-mr-related-subtask';
            subSection.dataset.ticketId = relSt.ticketId;
            const subHeader = document.createElement('div');
            subHeader.className = 'gl-mr-section';
            subHeader.textContent = `${relSt.ticketId} — ${relSt.summary}`;
            subSection.appendChild(subHeader);
            relSt.mrs.forEach(mr => subSection.appendChild(createMRItem(mr)));
            section.appendChild(subSection);
          });
        }

        body.appendChild(section);
      });
    }

    if (allMRs.length === 0) {
      body.innerHTML = '<div class="gl-mr-empty">No merge requests found</div>';
    }

    function applyFilters() {
      const ticketVal = body.querySelector('[data-filter-type="ticket"]')?.value || '';
      const stateVal = body.querySelector('[data-filter-type="state"]')?.value || '';
      body.querySelectorAll('.gl-mr-filter-section').forEach(s => {
        const ticketMatch = !ticketVal || s.dataset.ticketId === ticketVal;
        s.style.display = ticketMatch ? '' : 'none';
        if (ticketMatch) {
          s.querySelectorAll('.gl-mr-item').forEach(item => {
            item.style.display = (!stateVal || item.dataset.mrState === stateVal) ? '' : 'none';
          });
        }
      });
    }
  }

  function formatMergedTime(mergedAt) {
    if (!mergedAt) return '';
    const d = new Date(mergedAt);
    const now = new Date();
    const diffMs = now - d;
    const diffDays = Math.floor(diffMs / 86400000);
    let label;
    if (diffDays === 0 && d.toDateString() === now.toDateString()) label = 'Today';
    else if (diffDays <= 1 && new Date(now - 86400000).toDateString() === d.toDateString()) label = 'Yesterday';
    else label = d.toLocaleDateString();
    return ` (${label} ${d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})})`;
  }

  function createMRItem(mr) {
    const item = document.createElement('div');
    item.className = `gl-mr-item ${mr.state}`;
    item.dataset.mrState = mr.state;
    const envBadge = /^(main|master)$/.test(mr.targetBranch) ? '<span class="gl-mr-env prod">PROD</span>'
      : /^releases?\//.test(mr.targetBranch) ? '<span class="gl-mr-env uat">UAT</span>'
      : /^(testing|develop|dev)$/.test(mr.targetBranch) ? '<span class="gl-mr-env dev">DEV</span>' : '';
    const mergedTime = mr.state === 'merged' ? formatMergedTime(mr.mergedAt) : '';
    item.innerHTML = `
      <a href="${mr.webUrl}" target="_blank">!${mr.mrIid} ${mr.title}</a> ${envBadge}
      <div class="gl-mr-branches"><code>${mr.sourceBranch}</code> → <code>${mr.targetBranch}</code></div>
      <span class="gl-mr-state ${mr.state}">${mr.state}${mergedTime}</span>
      <div class="gl-mr-project">${mr.projectPath || ''}</div>
    `;
    return item;
  }

  function fetchAndRenderMRs(force) {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;
    if (!force && ticketId === lastTicketId) return;
    lastTicketId = ticketId;

    chrome.storage.sync.get({ mrDisplayMode: 'jira' }, (settings) => {
      if (settings.mrDisplayMode !== 'jira') {
        const panel = document.getElementById('gl-mr-panel');
        if (panel) panel.remove();
        return;
      }

      const panel = getOrCreatePanel();
      panel.querySelector('.gl-mr-status').textContent = `Loading MRs for ${ticketId}...`;
      panel.querySelector('.gl-mr-body').innerHTML = '';

      chrome.runtime.sendMessage({ action: 'lookupMRs', ticketId }, (response) => {
        if (chrome.runtime.lastError) {
          renderMRPanel({ error: 'Extension error' });
          return;
        }
        renderMRPanel(response || { error: 'No response' });
      });
    });
  }

  function onTicketChange() {
    const ticketId = getJiraTicketId();
    if (ticketId && ticketId !== lastTicketId) {
      fetchAndRenderMRs(false);
    } else if (!ticketId) {
      const panel = document.getElementById('gl-mr-panel');
      if (panel) panel.remove();
      lastTicketId = null;
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(observer._debounce);
    observer._debounce = setTimeout(onTicketChange, 500);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastTicketId = null;
      onTicketChange();
    }
  }, 1000);

  autoSend();
  checkParentSync();
  checkSubtasksSync();
  checkAllChildrenDone();

  setTimeout(() => fetchAndRenderMRs(false), 1500);
})();
