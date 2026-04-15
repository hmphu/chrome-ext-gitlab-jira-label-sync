const statusEl = document.getElementById('status');
const mrListEl = document.getElementById('mr-list');
const syncBtn = document.getElementById('sync-btn');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');
const optionsLink = document.getElementById('options-link');

let extractedData = null;
let pollTimer = null;

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
}

function renderMRList(mrs) {
  mrListEl.innerHTML = '';
  if (!mrs || mrs.length === 0) return;

  mrs.forEach(mr => {
    const item = document.createElement('div');
    item.className = 'mr-item';
    item.innerHTML = `
      <span class="title">${mr.title}</span>
      <span class="ticket">${mr.jiraTicket}</span>
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

async function init() {
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

  try {
    const response = await chrome.runtime.sendMessage({ action: 'extractFromTab' });
    if (!response || response.error || !response.mrs || response.mrs.length === 0) {
      if (!state.results.length) {
        setStatus('Navigate to a GitLab merge requests page to use this extension.', 'info');
      }
      syncBtn.disabled = true;
      return;
    }

    extractedData = response;
    setStatus(`Found ${response.mrs.length} merge request(s) with Jira tickets.`, 'info');
    renderMRList(response.mrs);
  } catch (e) {
    if (!state.results.length) {
      setStatus('Could not read page. Try refreshing the GitLab page.', 'error');
    }
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

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
