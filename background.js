let syncState = {
  running: false,
  progress: [],
  results: [],
  total: 0,
  completed: 0,
  error: null
};

async function getSettings() {
  return chrome.storage.sync.get({
    gitlabToken: '',
    gitlabBaseUrl: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraToken: '',
    jiraPattern: '[A-Z][A-Z0-9]+-\\d+'
  });
}

async function jiraFetch(settings, path) {
  const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
  const response = await fetch(`${settings.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/${path}`, {
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Accept': 'application/json'
    }
  });
  if (!response.ok) throw new Error(`Jira API error: ${response.status} ${response.statusText}`);
  return response.json();
}

async function gitlabFetch(settings, path, options = {}) {
  const url = `${settings.gitlabBaseUrl.replace(/\/$/, '')}/api/v4/${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'PRIVATE-TOKEN': settings.gitlabToken,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });
  if (!response.ok) throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
  return response.json();
}

async function getJiraLabels(settings, ticketId) {
  const issue = await jiraFetch(settings, `issue/${ticketId}?fields=labels`);
  return issue.fields.labels || [];
}

async function getGitlabProjectLabels(settings, projectPath) {
  const encoded = encodeURIComponent(projectPath);
  const labels = await gitlabFetch(settings, `projects/${encoded}/labels?per_page=100`);
  return labels.map(l => l.name);
}

async function createGitlabLabel(settings, projectPath, labelName) {
  const encoded = encodeURIComponent(projectPath);
  const color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
  return gitlabFetch(settings, `projects/${encoded}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: labelName, color })
  });
}

async function addLabelsToMR(settings, projectPath, mrIid, labels) {
  const encoded = encodeURIComponent(projectPath);
  const mr = await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mrIid}`);
  const existingLabels = mr.labels || [];
  const allLabels = [...new Set([...existingLabels, ...labels])];

  return gitlabFetch(settings, `projects/${encoded}/merge_requests/${mrIid}`, {
    method: 'PUT',
    body: JSON.stringify({ labels: allLabels.join(',') })
  });
}

function addProgress(msg) {
  syncState.progress.push(msg);
  chrome.runtime.sendMessage({ action: 'progressUpdate', message: msg }).catch(() => {});
}

async function syncLabelsForMR(settings, projectPath, mr) {
  const result = { mr: mr.title, jiraTicket: mr.jiraTicket, status: 'pending', labels: [], errors: [] };

  try {
    addProgress(`Fetching Jira labels for ${mr.jiraTicket}...`);
    const jiraLabels = await getJiraLabels(settings, mr.jiraTicket);

    if (jiraLabels.length === 0) {
      result.status = 'skipped';
      result.message = 'No labels on Jira ticket';
      return result;
    }

    result.labels = jiraLabels;
    addProgress(`Found ${jiraLabels.length} labels: ${jiraLabels.join(', ')}`);

    const existingLabels = await getGitlabProjectLabels(settings, projectPath);

    for (const label of jiraLabels) {
      if (!existingLabels.includes(label)) {
        addProgress(`Creating GitLab label: ${label}`);
        try {
          await createGitlabLabel(settings, projectPath, label);
        } catch (e) {
          if (!e.message.includes('409')) {
            result.errors.push(`Failed to create label "${label}": ${e.message}`);
          }
        }
      }
    }

    addProgress(`Adding labels to MR !${mr.mrIid}...`);
    await addLabelsToMR(settings, projectPath, mr.mrIid, jiraLabels);
    result.status = 'success';
  } catch (e) {
    result.status = 'error';
    result.errors.push(e.message);
  }

  return result;
}

async function runSync(data) {
  if (syncState.running) return;

  syncState = { running: true, progress: [], results: [], total: 0, completed: 0, error: null };

  const settings = await getSettings();

  if (!settings.gitlabToken || !settings.gitlabBaseUrl || !settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
    syncState.error = 'Please configure your API credentials in the extension options.';
    syncState.running = false;
    return;
  }

  const { mrs, projectPath } = data;
  if (!mrs || mrs.length === 0) {
    syncState.error = 'No merge requests with Jira tickets found on this page.';
    syncState.running = false;
    return;
  }

  if (!projectPath) {
    syncState.error = 'Could not determine GitLab project path from the current page.';
    syncState.running = false;
    return;
  }

  syncState.total = mrs.length;
  addProgress(`Starting sync for ${mrs.length} merge request(s)...`);

  for (const mr of mrs) {
    if (!mr.mrIid) {
      syncState.results.push({ mr: mr.title, jiraTicket: mr.jiraTicket, status: 'skipped', message: 'Could not determine MR IID' });
      syncState.completed++;
      continue;
    }
    const result = await syncLabelsForMR(settings, projectPath, mr);
    syncState.results.push(result);
    syncState.completed++;
  }

  addProgress('Sync complete.');
  syncState.running = false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startSync') {
    runSync(request.data);
    sendResponse({ started: true });
    return false;
  }

  if (request.action === 'getSyncState') {
    sendResponse(syncState);
    return false;
  }

  if (request.action === 'extractFromTab') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ error: 'No active tab' }); return; }
      chrome.tabs.sendMessage(tabs[0].id, { action: 'extractMRs' }, (response) => {
        sendResponse(response || { error: 'Could not read page' });
      });
    });
    return true;
  }
});
