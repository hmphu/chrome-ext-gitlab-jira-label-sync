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
    if (request.action === 'copyForTeams') {
      copyForTeams();
      sendResponse({ ok: true });
    }
    if (request.action === 'sendToTeams') {
      sendToTeams();
      sendResponse({ ok: true });
    }
    return true;
  });

  function checkParentSync() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkParentStatus', ticketId }, (response) => {
      if (!response || !response.hasParent) return;
      const parentStatusUpper = response.parentStatus.toUpperCase();
      const childStatusUpper = response.childStatus.toUpperCase();
      if (parentStatusUpper !== 'DONE' && parentStatusUpper !== 'DEPLOYED UAT') return;
      if (childStatusUpper === parentStatusUpper) return;

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

  function manualSyncWithParent() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    const btn = document.querySelector('#gl-sync-parent');
    const statusMsg = document.querySelector('.gl-sync-status-msg');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Checking...';
    }

    chrome.runtime.sendMessage({ action: 'checkParentStatus', ticketId }, (response) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Sync with Parent';
      }

      if (!response || response.error) {
        if (statusMsg) {
          statusMsg.textContent = response?.error || 'Failed to check parent status';
          statusMsg.className = 'gl-sync-status-msg error';
          statusMsg.style.display = '';
        }
        return;
      }

      if (!response.hasParent) {
        if (statusMsg) {
          statusMsg.textContent = 'This ticket has no parent';
          statusMsg.className = 'gl-sync-status-msg error';
          statusMsg.style.display = '';
        }
        return;
      }

      const parentStatusUpper = response.parentStatus.toUpperCase();
      const childStatusUpper = response.childStatus.toUpperCase();

      if (childStatusUpper === parentStatusUpper) {
        if (statusMsg) {
          statusMsg.textContent = `Already in sync with parent (${response.parentStatus})`;
          statusMsg.className = 'gl-sync-status-msg success';
          statusMsg.style.display = '';
        }
        return;
      }

      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Syncing...';
      }
      chrome.runtime.sendMessage({
        action: 'transitionChild',
        ticketId,
        targetStatus: response.parentStatus
      }, (res) => {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🔄 Sync with Parent';
        }
        if (res && res.success) {
          if (statusMsg) {
            statusMsg.textContent = 'Synced! Reloading...';
            statusMsg.className = 'gl-sync-status-msg success';
            statusMsg.style.display = '';
          }
          setTimeout(() => location.reload(), 1000);
        } else {
          if (statusMsg) {
            statusMsg.textContent = `Failed: ${res?.error || 'Unknown error'}`;
            statusMsg.className = 'gl-sync-status-msg error';
            statusMsg.style.display = '';
          }
        }
      });
    });
  }

  function copyForTeams() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    const btn = document.querySelector('#gl-copy-teams');
    const statusMsg = document.querySelector('.gl-sync-status-msg');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }

    chrome.runtime.sendMessage({ action: 'getJiraTicketDetails', ticketId }, (response) => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '📋 Copy for Teams';
      }

      if (!response || response.error) {
        if (statusMsg) {
          statusMsg.textContent = response?.error || 'Failed to get ticket details';
          statusMsg.className = 'gl-sync-status-msg error';
          statusMsg.style.display = '';
        }
        return;
      }

      const status = (response.status || '').toUpperCase();
      const env = status === 'DEPLOYED UAT' ? 'UAT' : 'SIT';
      const ticketUrl = window.location.href.split('?')[0];
      const title = (response.title || '').replace(/^\[SIT\]\s*/i, '');

      const text = `🎫 ${ticketId}: ${title}
🔗 ${ticketUrl}
🌐 Environment: ${env}
👤 Current Assignee: ${response.assignee || 'Unassigned'}`;

      navigator.clipboard.writeText(text).then(() => {
        if (statusMsg) {
          statusMsg.textContent = 'Copied to clipboard!';
          statusMsg.className = 'gl-sync-status-msg success';
          statusMsg.style.display = '';
        }
        setTimeout(() => {
          if (statusMsg) statusMsg.style.display = 'none';
        }, 2000);
      }).catch(() => {
        if (statusMsg) {
          statusMsg.textContent = 'Failed to copy';
          statusMsg.className = 'gl-sync-status-msg error';
          statusMsg.style.display = '';
        }
      });
    });
  }

  function sendToTeams() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    const btn = document.querySelector('#gl-send-teams');
    const statusMsg = document.querySelector('.gl-sync-status-msg');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Loading...';
    }

    chrome.storage.sync.get({ teamsWebhookUrl: '', teamsCustomMessage: '' }, (settings) => {
      if (!settings.teamsWebhookUrl) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '📤 Send to Teams';
        }
        if (statusMsg) {
          statusMsg.textContent = 'Please configure Teams Webhook URL in Settings';
          statusMsg.className = 'gl-sync-status-msg error';
          statusMsg.style.display = '';
        }
        return;
      }

      chrome.runtime.sendMessage({ action: 'getJiraTicketDetails', ticketId }, (response) => {
        if (!response || response.error) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '📤 Send to Teams';
          }
          if (statusMsg) {
            statusMsg.textContent = response?.error || 'Failed to get ticket details';
            statusMsg.className = 'gl-sync-status-msg error';
            statusMsg.style.display = '';
          }
          return;
        }

        const status = (response.status || '').toUpperCase();
        const env = status === 'DEPLOYED UAT' ? 'UAT' : 'SIT';
        const ticketUrl = window.location.href.split('?')[0];
        const title = (response.title || '').replace(/^\[SIT\]\s*/i, '');

        let text = `🎫 ${ticketId}: **${title}**
🔗 ${ticketUrl}
🌐 Environment: **${env}**
👤 Current Assignee: **${response.assignee || 'Unassigned'}**`;

        if (settings.teamsCustomMessage) {
          text += `\n\n💬 ${settings.teamsCustomMessage}`;
        }

        if (btn) btn.textContent = 'Sending...';

        const payload = {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                '$schema': 'http://adaptivecards.io/schemas/adaptive-card.json',
                type: 'AdaptiveCard',
                version: '1.5',
                body: [
                  {
                    type: 'TextBlock',
                    text: text,
                    wrap: true,
                    style: 'default'
                  }
                ],
                msteams: {
                  width: 'Full'
                }
              }
            }
          ]
        };

        fetch(settings.teamsWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(res => {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '📤 Send to Teams';
          }
          if (res.ok) {
            if (statusMsg) {
              statusMsg.textContent = 'Sent to Teams!';
              statusMsg.className = 'gl-sync-status-msg success';
              statusMsg.style.display = '';
            }
            setTimeout(() => {
              if (statusMsg) statusMsg.style.display = 'none';
            }, 2000);
          } else {
            if (statusMsg) {
              statusMsg.textContent = `Failed to send: ${res.status}`;
              statusMsg.className = 'gl-sync-status-msg error';
              statusMsg.style.display = '';
            }
          }
        }).catch(err => {
          if (btn) {
            btn.disabled = false;
            btn.textContent = '📤 Send to Teams';
          }
          if (statusMsg) {
            statusMsg.textContent = 'Failed to send';
            statusMsg.className = 'gl-sync-status-msg error';
            statusMsg.style.display = '';
          }
        });
      });
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
      #gl-mr-panel .gl-mr-env-summary{display:flex;gap:8px;margin-bottom:8px;font-size:11px;font-weight:500}
      #gl-mr-panel .gl-mr-env-status{padding:2px 6px;border-radius:3px;background:#f5f5f5}
      #gl-mr-panel .gl-mr-filter{flex:1;padding:4px 6px;border:1px solid #d0c8f0;border-radius:4px;font-size:11px;background:#faf8ff;color:#333}
      #gl-mr-panel .gl-mr-related-header{font-size:11px;font-weight:600;color:#1565c0;padding:4px 6px;margin:8px 0 4px;background:#e3f2fd;border-radius:3px}
      #gl-mr-panel .gl-mr-related-section{border-left:3px solid #1565c0;padding-left:4px}
      #gl-mr-panel .gl-mr-related-subtask{margin-left:8px;border-left:2px solid #90caf9;padding-left:4px}
      #gl-mr-panel .gl-mr-link-type{font-size:9px;font-weight:400;background:#bbdefb;padding:1px 4px;border-radius:3px;color:#1565c0;margin:0 2px}
      #gl-mr-panel .gl-qa-section{margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0}
      #gl-mr-panel .gl-qa-header{display:flex;align-items:center;justify-content:space-between;cursor:pointer;margin-bottom:8px}
      #gl-mr-panel .gl-qa-title{font-size:12px;font-weight:600;color:#6b4fbb;display:flex;align-items:center;gap:6px}
      #gl-mr-panel .gl-qa-toggle{font-size:10px;color:#888}
      #gl-mr-panel .gl-qa-refresh{background:none;border:none;cursor:pointer;color:#6b4fbb;font-size:14px;padding:2px 4px;border-radius:4px}
      #gl-mr-panel .gl-qa-refresh:hover{background:#f3e8fd}
      #gl-mr-panel .gl-qa-form{display:flex;flex-direction:column;gap:8px}
      #gl-mr-panel .gl-qa-field{display:flex;flex-direction:column;gap:2px}
      #gl-mr-panel .gl-qa-label{font-size:10px;font-weight:500;color:#666}
      #gl-mr-panel .gl-qa-select{padding:6px 8px;border:1px solid #d0c8f0;border-radius:4px;font-size:11px;background:#faf8ff;color:#333}
      #gl-mr-panel .gl-qa-select optgroup{font-weight:600;color:#6b4fbb}
      #gl-mr-panel .gl-qa-textarea{padding:6px 8px;border:1px solid #d0c8f0;border-radius:4px;font-size:11px;background:#faf8ff;color:#333;resize:vertical;min-height:60px;font-family:inherit}
      #gl-mr-panel .gl-qa-checkbox{display:flex;align-items:center;gap:6px;font-size:11px;color:#555}
      #gl-mr-panel .gl-qa-checkbox input{margin:0}
      #gl-mr-panel .gl-qa-submit{padding:8px 12px;background:#6b4fbb;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer}
      #gl-mr-panel .gl-qa-submit:hover{background:#5a3fa8}
      #gl-mr-panel .gl-qa-submit:disabled{background:#ccc;cursor:not-allowed}
      #gl-mr-panel .gl-sync-section{margin-top:12px;padding-top:12px;border-top:1px solid #e0e0e0;display:flex;flex-direction:column;gap:6px}
      #gl-mr-panel .gl-sync-parent-btn{width:100%;padding:8px 12px;background:#1565c0;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer}
      #gl-mr-panel .gl-sync-parent-btn:hover{background:#0d47a1}
      #gl-mr-panel .gl-sync-parent-btn:disabled{background:#ccc;cursor:not-allowed}
      #gl-mr-panel .gl-copy-teams-btn{width:100%;padding:8px 12px;background:#5b5fc7;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer}
      #gl-mr-panel .gl-copy-teams-btn:hover{background:#4b4fb7}
      #gl-mr-panel .gl-copy-teams-btn:disabled{background:#ccc;cursor:not-allowed}
      #gl-mr-panel .gl-send-teams-btn{width:100%;padding:8px 12px;background:#464EB8;color:#fff;border:none;border-radius:4px;font-size:11px;font-weight:500;cursor:pointer}
      #gl-mr-panel .gl-send-teams-btn:hover{background:#3644A5}
      #gl-mr-panel .gl-send-teams-btn:disabled{background:#ccc;cursor:not-allowed}
      #gl-mr-panel .gl-sync-status-msg{font-size:10px;padding:4px 6px;border-radius:3px;margin-top:4px}
      #gl-mr-panel .gl-sync-status-msg.success{background:#e8f5e9;color:#2e7d32}
      #gl-mr-panel .gl-sync-status-msg.error{background:#fdecea;color:#c62828}
      #gl-mr-panel .gl-qa-status{font-size:10px;padding:4px 6px;border-radius:3px;margin-top:4px}
      #gl-mr-panel .gl-qa-status.success{background:#e8f5e9;color:#2e7d32}
      #gl-mr-panel .gl-qa-status.error{background:#fdecea;color:#c62828}
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
          <span class="gl-mr-toggle">▶</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg>
          GitLab MRs
        </span>
        <button class="gl-mr-refresh" title="Refresh">↻</button>
      </div>
      <div class="gl-mr-content" style="display:none">
        <div class="gl-mr-status">Loading...</div>
        <div class="gl-mr-body"></div>
      </div>
      <div class="gl-qa-section">
        <div class="gl-qa-header">
          <span class="gl-qa-title">
            <span class="gl-qa-toggle">▶</span>
            ⚡ Quick Actions
          </span>
          <button class="gl-qa-refresh" title="Refresh dropdowns">↻</button>
        </div>
        <div class="gl-qa-content" style="display:none">
          <div class="gl-qa-form">
            <div class="gl-qa-field">
              <label class="gl-qa-label">Change Status</label>
              <select class="gl-qa-select" id="gl-qa-status">
                <option value="">— No change —</option>
              </select>
            </div>
            <div class="gl-qa-field">
              <label class="gl-qa-label">Assign To</label>
              <select class="gl-qa-select" id="gl-qa-assignee">
                <option value="">— No change —</option>
              </select>
            </div>
            <div class="gl-qa-field">
              <label class="gl-qa-label">Comment</label>
              <select class="gl-qa-select gl-qa-recent-comments" id="gl-qa-recent-comments" style="margin-bottom:4px">
                <option value="">— Recent comments —</option>
              </select>
              <textarea class="gl-qa-textarea" id="gl-qa-comment" placeholder="Add a comment..."></textarea>
            </div>
            <label class="gl-qa-checkbox">
              <input type="checkbox" id="gl-qa-tag" checked>
              Tag assignee in comment
            </label>
            <button class="gl-qa-submit" id="gl-qa-submit">Submit</button>
            <div class="gl-qa-status-msg" style="display:none"></div>
          </div>
        </div>
      </div>
      <div class="gl-sync-section">
        <button class="gl-sync-parent-btn" id="gl-sync-parent">🔄 Sync with Parent</button>
        <button class="gl-copy-teams-btn" id="gl-copy-teams">📋 Copy for Teams</button>
        <button class="gl-send-teams-btn" id="gl-send-teams">📤 Send to Teams</button>
        <div class="gl-sync-status-msg" style="display:none"></div>
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
    panel.querySelector('.gl-qa-header').addEventListener('click', (e) => {
      if (e.target.closest('.gl-qa-refresh')) return;
      const content = panel.querySelector('.gl-qa-content');
      const toggle = panel.querySelector('.gl-qa-toggle');
      const collapsed = content.style.display === 'none';
      content.style.display = collapsed ? '' : 'none';
      toggle.textContent = collapsed ? '▼' : '▶';
    });
    panel.querySelector('.gl-qa-refresh').addEventListener('click', () => loadQuickActionData());
    panel.querySelector('#gl-qa-submit').addEventListener('click', () => submitQuickAction());
    panel.querySelector('#gl-qa-recent-comments').addEventListener('change', (e) => {
      if (e.target.value) {
        panel.querySelector('#gl-qa-comment').value = e.target.value;
        e.target.value = '';
      }
    });
    panel.querySelector('#gl-sync-parent').addEventListener('click', () => manualSyncWithParent());
    panel.querySelector('#gl-copy-teams').addEventListener('click', () => copyForTeams());
    panel.querySelector('#gl-send-teams').addEventListener('click', () => sendToTeams());

    chrome.storage.sync.get({ showCopyForTeams: true, showSendToTeams: true }, (settings) => {
      const copyBtn = panel.querySelector('#gl-copy-teams');
      const sendBtn = panel.querySelector('#gl-send-teams');
      if (copyBtn) copyBtn.style.display = settings.showCopyForTeams ? '' : 'none';
      if (sendBtn) sendBtn.style.display = settings.showSendToTeams ? '' : 'none';
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
    const envs = [...new Set(allMRs.map(mr => {
      if (/^(main|master)$/.test(mr.targetBranch)) return 'PROD';
      if (/^releases?\//.test(mr.targetBranch)) return 'UAT';
      if (/^(testing|develop|dev)$/.test(mr.targetBranch)) return 'DEV';
      return '';
    }).filter(Boolean))];

    // Environment merge summary
    if (envs.length > 0) {
      const envSummary = document.createElement('div');
      envSummary.className = 'gl-mr-env-summary';
      const envOrder = ['DEV', 'UAT', 'PROD'];
      envSummary.innerHTML = envOrder.filter(e => envs.includes(e)).map(env => {
        const envMRs = allMRs.filter(mr => {
          if (env === 'PROD') return /^(main|master)$/.test(mr.targetBranch);
          if (env === 'UAT') return /^releases?\//.test(mr.targetBranch);
          if (env === 'DEV') return /^(testing|develop|dev)$/.test(mr.targetBranch);
          return false;
        });
        const allMerged = envMRs.every(mr => mr.state === 'merged' || mr.state === 'closed');
        const icon = allMerged ? '✅' : '❌';
        return `<span class="gl-mr-env-status">${icon} ${env}</span>`;
      }).join(' ');
      body.appendChild(envSummary);
    }

    if (allMRs.length > 0 && (allTicketIds.length > 1 || states.length > 1 || envs.length > 1)) {
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

      if (envs.length > 1) {
        const ef = document.createElement('select');
        ef.className = 'gl-mr-filter';
        ef.dataset.filterType = 'env';
        ef.innerHTML = `<option value="">All envs</option>` + envs.map(e => `<option value="${e}">${e}</option>`).join('');
        ef.addEventListener('change', applyFilters);
        filterRow.appendChild(ef);
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
      const envVal = body.querySelector('[data-filter-type="env"]')?.value || '';
      body.querySelectorAll('.gl-mr-filter-section').forEach(s => {
        const ticketMatch = !ticketVal || s.dataset.ticketId === ticketVal;
        s.style.display = ticketMatch ? '' : 'none';
        if (ticketMatch) {
          s.querySelectorAll('.gl-mr-item').forEach(item => {
            const stateMatch = !stateVal || item.dataset.mrState === stateVal;
            const envMatch = !envVal || item.dataset.mrEnv === envVal;
            item.style.display = (stateMatch && envMatch) ? '' : 'none';
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
    const env = /^(main|master)$/.test(mr.targetBranch) ? 'PROD'
      : /^releases?\//.test(mr.targetBranch) ? 'UAT'
      : /^(testing|develop|dev)$/.test(mr.targetBranch) ? 'DEV' : '';
    item.dataset.mrEnv = env;
    const envBadge = env === 'PROD' ? '<span class="gl-mr-env prod">PROD</span>'
      : env === 'UAT' ? '<span class="gl-mr-env uat">UAT</span>'
      : env === 'DEV' ? '<span class="gl-mr-env dev">DEV</span>' : '';
    const mergedTime = mr.state === 'merged' ? formatMergedTime(mr.mergedAt) : '';
    item.innerHTML = `
      <a href="${mr.webUrl}" target="_blank">!${mr.mrIid} ${mr.title}</a> ${envBadge}
      <div class="gl-mr-branches"><code>${mr.sourceBranch}</code> → <code>${mr.targetBranch}</code></div>
      <span class="gl-mr-state ${mr.state}">${mr.state}${mergedTime}</span>
      <div class="gl-mr-project">${mr.projectPath || ''}</div>
    `;
    return item;
  }

  function loadQuickActionData() {
    const ticketId = getJiraTicketId();
    console.log('[GitLab Toolbox] loadQuickActionData called, ticketId:', ticketId);
    if (!ticketId) return;

    const panel = document.getElementById('gl-mr-panel');
    if (!panel) {
      console.log('[GitLab Toolbox] panel not found');
      return;
    }

    const statusSelect = panel.querySelector('#gl-qa-status');
    const assigneeSelect = panel.querySelector('#gl-qa-assignee');
    const refreshBtn = panel.querySelector('.gl-qa-refresh');
    const qaContent = panel.querySelector('.gl-qa-content');
    if (!statusSelect || !assigneeSelect) {
      console.log('[GitLab Toolbox] selects not found', { statusSelect, assigneeSelect });
      return;
    }

    // Show loading state
    statusSelect.disabled = true;
    assigneeSelect.disabled = true;
    statusSelect.innerHTML = '<option value="">Loading...</option>';
    assigneeSelect.innerHTML = '<option value="">Loading...</option>';
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.style.opacity = '0.5';
    }

    let completed = 0;
    const checkComplete = () => {
      completed++;
      if (completed >= 2 && refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.style.opacity = '';
      }
    };

    console.log('[GitLab Toolbox] Fetching transitions and assignees...');

    chrome.runtime.sendMessage({ action: 'getJiraTransitions', ticketId }, (response) => {
      console.log('[GitLab Toolbox] getJiraTransitions response:', response);
      if (chrome.runtime.lastError) {
        console.error('getJiraTransitions error:', chrome.runtime.lastError);
        checkComplete();
        return;
      }
      if (response?.error) {
        console.error('getJiraTransitions error:', response.error);
        checkComplete();
        return;
      }
      const panel = document.getElementById('gl-mr-panel');
      const statusSelect = panel?.querySelector('#gl-qa-status');
      if (!statusSelect) {
        console.error('[GitLab Toolbox] statusSelect not found in callback');
        checkComplete();
        return;
      }
      statusSelect.disabled = false;
      statusSelect.innerHTML = '<option value="">— No change —</option>';
      (response.transitions || []).forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name;
        statusSelect.appendChild(opt);
      });
      console.log('[GitLab Toolbox] statusSelect populated with', (response.transitions || []).length, 'options');
      checkComplete();
    });

    chrome.runtime.sendMessage({ action: 'getJiraAssignees', ticketId }, (response) => {
      console.log('[GitLab Toolbox] getJiraAssignees response:', response);
      if (chrome.runtime.lastError) {
        console.error('getJiraAssignees error:', chrome.runtime.lastError);
        checkComplete();
        return;
      }
      if (response?.error) {
        console.error('getJiraAssignees error:', response.error);
        checkComplete();
        return;
      }
      const panel = document.getElementById('gl-mr-panel');
      const assigneeSelect = panel?.querySelector('#gl-qa-assignee');
      if (!assigneeSelect) {
        console.error('[GitLab Toolbox] assigneeSelect not found in callback');
        checkComplete();
        return;
      }
      assigneeSelect.disabled = false;
      assigneeSelect.innerHTML = '<option value="">— No change —</option>';

      const recentIds = new Set((response.recentAssignees || []).map(a => a.accountId));
      if (response.recentAssignees && response.recentAssignees.length > 0) {
        const recentGroup = document.createElement('optgroup');
        recentGroup.label = 'Recently Used';
        response.recentAssignees.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.accountId;
          opt.textContent = u.displayName;
          opt.dataset.name = u.displayName;
          recentGroup.appendChild(opt);
        });
        assigneeSelect.appendChild(recentGroup);
      }

      const projectUsers = (response.users || []).filter(u => !recentIds.has(u.accountId));
      if (projectUsers.length > 0) {
        const projectGroup = document.createElement('optgroup');
        projectGroup.label = 'Project Members';
        projectUsers.forEach(u => {
          const opt = document.createElement('option');
          opt.value = u.accountId;
          opt.textContent = u.displayName;
          opt.dataset.name = u.displayName;
          projectGroup.appendChild(opt);
        });
        assigneeSelect.appendChild(projectGroup);
      }
      console.log('[GitLab Toolbox] assigneeSelect populated with', (response.users || []).length, 'users');
      checkComplete();
    });

    // Load recent comments
    chrome.storage.local.get({ recentComments: [] }, (data) => {
      const panel = document.getElementById('gl-mr-panel');
      const recentCommentsSelect = panel?.querySelector('#gl-qa-recent-comments');
      if (!recentCommentsSelect) return;
      recentCommentsSelect.innerHTML = '<option value="">— Recent comments —</option>';
      (data.recentComments || []).forEach(comment => {
        const opt = document.createElement('option');
        opt.value = comment;
        opt.textContent = comment.length > 50 ? comment.substring(0, 50) + '...' : comment;
        recentCommentsSelect.appendChild(opt);
      });
    });
  }

  function submitQuickAction() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    const panel = document.getElementById('gl-mr-panel');
    if (!panel) return;

    const statusSelect = panel.querySelector('#gl-qa-status');
    const assigneeSelect = panel.querySelector('#gl-qa-assignee');
    const commentInput = panel.querySelector('#gl-qa-comment');
    const tagCheckbox = panel.querySelector('#gl-qa-tag');
    const submitBtn = panel.querySelector('#gl-qa-submit');
    const statusMsg = panel.querySelector('.gl-qa-status-msg');

    const transitionId = statusSelect.value || null;
    const assigneeId = assigneeSelect.value || null;
    const assigneeName = assigneeSelect.selectedOptions[0]?.dataset?.name || '';
    const comment = commentInput.value.trim() || null;
    const tagAssignee = tagCheckbox.checked;

    if (!transitionId && !assigneeId && !comment) {
      statusMsg.textContent = 'Please fill at least one field';
      statusMsg.className = 'gl-qa-status-msg gl-qa-status error';
      statusMsg.style.display = '';
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';
    statusMsg.style.display = 'none';

    chrome.runtime.sendMessage({
      action: 'jiraQuickAction',
      ticketId,
      transitionId,
      assigneeId,
      assigneeName,
      comment,
      tagAssignee
    }, (response) => {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit';

      if (chrome.runtime.lastError || response?.error) {
        statusMsg.textContent = response?.error || 'Failed to submit';
        statusMsg.className = 'gl-qa-status-msg gl-qa-status error';
        statusMsg.style.display = '';
        return;
      }

      statusMsg.textContent = 'Success! Reloading...';
      statusMsg.className = 'gl-qa-status-msg gl-qa-status success';
      statusMsg.style.display = '';

      // Save comment to recent comments
      if (comment) {
        chrome.storage.local.get({ recentComments: [] }, (data) => {
          const updated = [comment, ...data.recentComments.filter(c => c !== comment)].slice(0, 10);
          chrome.storage.local.set({ recentComments: updated });
        });
      }

      statusSelect.value = '';
      assigneeSelect.value = '';
      commentInput.value = '';

      setTimeout(() => location.reload(), 1000);
    });
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
      loadQuickActionData();

      chrome.runtime.sendMessage({ action: 'lookupMRs', ticketId }, (response) => {
        console.log('[GitLab Toolbox] lookupMRs response:', JSON.stringify(response, null, 2));
        if (chrome.runtime.lastError) {
          console.error('[GitLab Toolbox] lookupMRs error:', chrome.runtime.lastError);
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
