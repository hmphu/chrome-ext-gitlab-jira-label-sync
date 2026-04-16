const statusEl = document.getElementById('status');
const gitlabView = document.getElementById('gitlab-view');
const jiraView = document.getElementById('jira-view');
const mrListEl = document.getElementById('mr-list');
const syncBtn = document.getElementById('sync-btn');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');
const jiraTicketEl = document.getElementById('jira-ticket');
const lookupBtn = document.getElementById('lookup-btn');
const jiraResultsEl = document.getElementById('jira-results');
const optionsLink = document.getElementById('options-link');

let extractedData = null;
let pollTimer = null;

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
}

function showGitlabView() {
  gitlabView.style.display = '';
  jiraView.style.display = 'none';
}

function showJiraView() {
  gitlabView.style.display = 'none';
  jiraView.style.display = '';
}

function renderMRList(mrs) {
  mrListEl.innerHTML = '';
  if (!mrs || mrs.length === 0) return;

  mrs.forEach(mr => {
    const item = document.createElement('div');
    item.className = 'mr-item';
    item.innerHTML = `
      <span class="title">${mr.title}</span>
      <span class="ticket">${mr.jiraTicket || ''}</span>
    `;
    mrListEl.appendChild(item);
  });
}

function renderProgress(logs) {
  progressEl.innerHTML = '';
  logs.forEach(msg => {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    progressEl.appendChild(entry);
  });
  progressEl.scrollTop = progressEl.scrollHeight;
}

function renderResults(results) {
  resultsEl.innerHTML = '';
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = `result-item ${r.status}`;

    let html = `<strong>${r.jiraTicket || 'Unknown'}</strong> — ${r.status}`;
    if (r.message) html += `: ${r.message}`;
    if (r.errors && r.errors.length > 0) html += `<br>${r.errors.join('<br>')}`;
    if (r.labels && r.labels.length > 0) {
      html += '<div class="result-labels">';
      r.labels.forEach(l => { html += `<span class="label-tag">${l}</span>`; });
      html += '</div>';
    }

    item.innerHTML = html;
    resultsEl.appendChild(item);
  });
}

function renderJiraResults(data) {
  jiraResultsEl.innerHTML = '';

  if (data.error) {
    setStatus(data.error, 'error');
    return;
  }

  if (!data.mrs || data.mrs.length === 0) {
    setStatus(`No merge requests found for ${data.ticketId}`, 'info');
    return;
  }

  setStatus(`Found ${data.mrs.length} merge request(s) for ${data.ticketId}`, 'success');

  data.mrs.forEach(mr => {
    const item = document.createElement('div');
    item.className = 'mr-lookup-item';
    item.innerHTML = `
      <div class="mr-title"><a href="${mr.webUrl}" target="_blank">!${mr.mrIid} ${mr.title}</a></div>
      <div class="mr-branches"><code>${mr.sourceBranch}</code> → <code>${mr.targetBranch}</code></div>
      <span class="mr-state ${mr.state}">${mr.state}${mr.mergedAt ? ' (' + new Date(mr.mergedAt).toLocaleDateString() + ')' : ''}</span>
      <span style="font-size:10px;color:#888;margin-left:4px">${mr.projectPath}</span>
    `;
    jiraResultsEl.appendChild(item);
  });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const state = await chrome.runtime.sendMessage({ action: 'getSyncState' });
      renderProgress(state.progress);

      if (state.running) {
        setStatus(`Syncing... ${state.completed}/${state.total}`, 'info');
        syncBtn.disabled = true;
        syncBtn.textContent = `Syncing ${state.completed}/${state.total}...`;
      } else {
        clearInterval(pollTimer);
        pollTimer = null;

        if (state.error) {
          setStatus(state.error, 'error');
        } else if (state.results.length > 0) {
          const successCount = state.results.filter(r => r.status === 'success').length;
          setStatus(`Sync complete: ${successCount}/${state.results.length} succeeded.`, 'success');
          renderResults(state.results);
        }

        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync Labels';
      }
    } catch (e) {}
  }, 500);
}

async function initGitlab(context) {
  showGitlabView();

  const state = await chrome.runtime.sendMessage({ action: 'getSyncState' });
  if (state.running) {
    setStatus(`Sync in progress... ${state.completed}/${state.total}`, 'info');
    syncBtn.disabled = true;
    syncBtn.textContent = `Syncing ${state.completed}/${state.total}...`;
    renderProgress(state.progress);
    startPolling();
    return;
  }

  if (state.results.length > 0 && state.progress.length > 0) {
    const successCount = state.results.filter(r => r.status === 'success').length;
    setStatus(`Last sync: ${successCount}/${state.results.length} succeeded.`, 'success');
    renderProgress(state.progress);
    renderResults(state.results);
  }

  if (context && context.mrs && context.mrs.length > 0) {
    extractedData = context;
    setStatus(`Found ${context.mrs.length} merge request(s) with Jira tickets.`, 'info');
    renderMRList(context.mrs);
  } else {
    if (!state.results.length) {
      setStatus('No merge requests found on this page.', 'info');
    }
    syncBtn.disabled = true;
  }
}

async function initJira(ticketId) {
  showJiraView();
  jiraTicketEl.textContent = ticketId;
  setStatus(`Viewing Jira ticket: ${ticketId}`, 'info');
}

async function init() {
  try {
    const context = await chrome.runtime.sendMessage({ action: 'getPageContext' });

    if (context.type === 'jira') {
      await initJira(context.ticketId);
    } else if (context.type === 'gitlab') {
      await initGitlab(context);
    } else {
      showGitlabView();
      const state = await chrome.runtime.sendMessage({ action: 'getSyncState' });
      if (state.results.length > 0 && state.progress.length > 0) {
        const successCount = state.results.filter(r => r.status === 'success').length;
        setStatus(`Last sync: ${successCount}/${state.results.length} succeeded.`, 'success');
        renderProgress(state.progress);
        renderResults(state.results);
      } else {
        setStatus('Navigate to a GitLab MR page or Jira ticket to use this extension.', 'info');
      }
      syncBtn.disabled = true;
    }
  } catch (e) {
    setStatus('Could not read page. Try refreshing.', 'error');
    syncBtn.disabled = true;
  }
}

syncBtn.addEventListener('click', async () => {
  if (!extractedData) return;

  syncBtn.disabled = true;
  syncBtn.textContent = 'Starting...';
  progressEl.innerHTML = '';
  resultsEl.innerHTML = '';

  await chrome.runtime.sendMessage({ action: 'startSync', data: extractedData });
  startPolling();
});

lookupBtn.addEventListener('click', async () => {
  const ticketId = jiraTicketEl.textContent.trim();
  if (!ticketId) return;

  lookupBtn.disabled = true;
  lookupBtn.textContent = 'Searching...';
  jiraResultsEl.innerHTML = '';
  setStatus(`Searching GitLab for ${ticketId}...`, 'info');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'lookupMRs', ticketId });
    renderJiraResults(result);
  } catch (e) {
    setStatus(`Lookup failed: ${e.message}`, 'error');
  }

  lookupBtn.disabled = false;
  lookupBtn.textContent = 'Lookup Merge Requests';
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
