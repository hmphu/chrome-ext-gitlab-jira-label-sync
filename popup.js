const statusEl = document.getElementById('status');
const mrListEl = document.getElementById('mr-list');
const syncBtn = document.getElementById('sync-btn');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');
const optionsLink = document.getElementById('options-link');

let extractedData = null;

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

function addProgressLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = message;
  progressEl.appendChild(entry);
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

async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('merge_requests')) {
      setStatus('Navigate to a GitLab merge requests page to use this extension.', 'info');
      syncBtn.disabled = true;
      return;
    }

    const response = await chrome.tabs.sendMessage(tab.id, { action: 'extractMRs' });
    if (!response || !response.mrs || response.mrs.length === 0) {
      setStatus('No merge requests with Jira ticket IDs found on this page.', 'info');
      syncBtn.disabled = true;
      return;
    }

    extractedData = response;
    setStatus(`Found ${response.mrs.length} merge request(s) with Jira tickets.`, 'info');
    renderMRList(response.mrs);
  } catch (e) {
    setStatus('Could not read page. Try refreshing the GitLab page.', 'error');
    syncBtn.disabled = true;
  }
}

syncBtn.addEventListener('click', async () => {
  if (!extractedData) return;

  syncBtn.disabled = true;
  syncBtn.textContent = 'Syncing...';
  progressEl.innerHTML = '';
  resultsEl.innerHTML = '';

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'progressUpdate') {
      addProgressLog(msg.message);
    }
  });

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'syncLabels',
      data: extractedData
    });

    if (result.error) {
      setStatus(result.error, 'error');
    } else if (result.results) {
      const successCount = result.results.filter(r => r.status === 'success').length;
      setStatus(`Sync complete: ${successCount}/${result.results.length} succeeded.`, 'success');
      renderResults(result.results);
    }
  } catch (e) {
    setStatus(`Sync failed: ${e.message}`, 'error');
  }

  syncBtn.disabled = false;
  syncBtn.textContent = 'Sync Labels';
});

optionsLink.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

init();
