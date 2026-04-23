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

function getMissingReleaseMRAlert(ticketId, mrs) {
  const hasRelease = mrs.some(mr => /^releases\//.test(mr.targetBranch));
  const hasTesting = mrs.some(mr => mr.targetBranch === 'testing');
  if (hasTesting && !hasRelease) {
    const alert = document.createElement('div');
    alert.className = 'missing-release-alert';
    alert.textContent = `⚠ ${ticketId} has MR to testing but no MR to releases/*`;
    return alert;
  }
  return null;
}

function renderMRItems(container, mrs) {
  mrs.forEach(mr => {
    const isRelease = /^releases\//.test(mr.targetBranch);
    const isOpen = mr.state === 'opened';
    const item = document.createElement('div');
    item.className = 'mr-lookup-item' + (isRelease ? ' release-target' : '') + (isOpen ? ' open-mr' : '');
    item.innerHTML = `
      <div class="mr-title"><a href="#" data-url="${mr.webUrl}">!${mr.mrIid} ${mr.title}</a></div>
      <div class="mr-branches"><code>${mr.sourceBranch}</code> → <code class="target">${mr.targetBranch}</code></div>
      <span class="mr-state ${mr.state}">${mr.state}${mr.mergedAt ? (() => { const d = new Date(mr.mergedAt); const today = new Date(); const isToday = d.toDateString() === today.toDateString(); return ' (' + (isToday ? 'Today' : d.toLocaleDateString()) + ' ' + d.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) + ')'; })() : ''}</span>
      <span style="font-size:10px;color:#888;margin-left:4px">${mr.projectPath}</span>
    `;
    item.querySelector('a[data-url]').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: mr.webUrl, active: false });
    });
    container.appendChild(item);
  });
}

function renderJiraResults(data) {
  jiraResultsEl.innerHTML = '';

  if (data.error) {
    setStatus(data.error, 'error');
    return;
  }

  const totalMRs = (data.mrs || []).length + (data.subtasks || []).reduce((sum, st) => sum + st.mrs.length, 0);
  const subtaskCount = (data.subtasks || []).length;

  if (totalMRs === 0 && subtaskCount === 0) {
    setStatus(`No merge requests found for ${data.ticketId}`, 'info');
    return;
  }

  setStatus(`Found ${totalMRs} MR(s) for ${data.ticketId}${subtaskCount > 0 ? ` + ${subtaskCount} subtask(s)` : ''}`, 'success');

  if (data.mrs && data.mrs.length > 0) {
    const section = document.createElement('div');
    section.className = 'lookup-section';
    section.innerHTML = `<div class="lookup-section-header">${data.ticketId}</div>`;
    const alert = getMissingReleaseMRAlert(data.ticketId, data.mrs);
    if (alert) section.appendChild(alert);
    renderMRItems(section, data.mrs);
    jiraResultsEl.appendChild(section);
  }

  if (data.subtasks) {
    data.subtasks.forEach(st => {
      const section = document.createElement('div');
      section.className = 'lookup-section';
      section.innerHTML = `<div class="lookup-section-header">${st.ticketId} <span class="subtask-summary">${st.summary}</span> <span class="subtask-status">${st.status}</span></div>`;
      if (st.mrs.length > 0) {
        const alert = getMissingReleaseMRAlert(st.ticketId, st.mrs);
        if (alert) section.appendChild(alert);
        renderMRItems(section, st.mrs);
      } else {
        const empty = document.createElement('div');
        empty.className = 'no-mrs';
        empty.textContent = 'No merge requests found';
        section.appendChild(empty);
      }
      jiraResultsEl.appendChild(section);
    });
  }
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

  const settings = await chrome.storage.sync.get({ autoLookup: true });
  if (settings.autoLookup) {
    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Searching...';
    setStatus(`Searching GitLab for ${ticketId}...`, 'info');
    try {
      const result = await chrome.runtime.sendMessage({ action: 'lookupMRs', ticketId });
      renderJiraResults(result);
    } catch (e) {
      setStatus(`Lookup failed: ${e.message}`, 'error');
    }
    lookupBtn.disabled = false;
    lookupBtn.textContent = 'Lookup Merge Requests';
  } else {
    setStatus(`Viewing Jira ticket: ${ticketId}`, 'info');
  }
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

async function createMRToTarget(targetBranch) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const host = projectMatch ? projectMatch[1] : (rootMatch ? rootMatch[1] : null);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!host || !projectPath) {
    setStatus('Navigate to a GitLab project page first.', 'error');
    return;
  }

  try {
    const settings = await chrome.storage.sync.get({ gitlabToken: '', gitlabBaseUrl: '' });
    const encoded = encodeURIComponent(projectPath);
    const res = await fetch(`${settings.gitlabBaseUrl.replace(/\/$/, '')}/api/v4/projects/${encoded}`, {
      headers: { 'PRIVATE-TOKEN': settings.gitlabToken }
    });
    const project = await res.json();
    const defaultBranch = project.default_branch || 'main';
    const mrUrl = `https://${host}/${projectPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(defaultBranch)}&merge_request[target_branch]=${encodeURIComponent(targetBranch)}`;
    chrome.tabs.create({ url: mrUrl, active: true });
  } catch (e) {
    setStatus(`Failed to create MR link: ${e.message}`, 'error');
  }
}

document.getElementById('create-mr-testing-btn').addEventListener('click', (e) => {
  e.preventDefault();
  createMRToTarget('testing');
});

document.getElementById('create-mr-main-btn').addEventListener('click', (e) => {
  e.preventDefault();
  createMRToTarget('main');
});

document.getElementById('fix-mrs-btn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!projectPath) {
    setStatus('Navigate to a GitLab project page first.', 'error');
    return;
  }

  const btn = document.getElementById('fix-mrs-btn');
  btn.disabled = true;
  btn.textContent = 'Fixing...';
  setStatus('Scanning for broken MRs...', 'info');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'fixBrokenMRs', projectPath });
    if (result.error) {
      setStatus(result.error, 'error');
    } else if (result.fixed === 0) {
      setStatus(result.message || 'No broken MRs found.', 'success');
    } else {
      let msg = `Fixed ${result.fixed}/${result.total} MR(s) → ${result.defaultBranch}`;
      if (result.errors && result.errors.length > 0) msg += `. Errors: ${result.errors.join(', ')}`;
      setStatus(msg, result.errors && result.errors.length ? 'error' : 'success');
    }
  } catch (e) {
    setStatus(`Failed: ${e.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Fix Broken MR Targets';
});

document.getElementById('create-mr-main-to-testing-btn').addEventListener('click', async (e) => {
  e.preventDefault();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const host = projectMatch ? projectMatch[1] : (rootMatch ? rootMatch[1] : null);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!host || !projectPath) {
    setStatus('Navigate to a GitLab project page first.', 'error');
    return;
  }

  const mrUrl = `https://${host}/${projectPath}/-/merge_requests/new?merge_request[source_branch]=main&merge_request[target_branch]=testing&merge_request[title]=${encodeURIComponent('Sync main into testing')}`;
  chrome.tabs.create({ url: mrUrl, active: true });
});

init();
