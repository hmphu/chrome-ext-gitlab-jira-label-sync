let syncState = {
  running: false,
  progress: [],
  results: [],
  total: 0,
  completed: 0,
  error: null
};

let queue = [];
let seen = new Set();
let syncStarted = false;

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

function enqueue(mrs, projectPath) {
  let added = 0;
  for (const mr of mrs) {
    if (!mr.mrIid) continue;
    const key = `${projectPath}::${mr.mrIid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queue.push({ ...mr, projectPath });
    added++;
  }
  if (added > 0) {
    syncState.total += added;
    addProgress(`+${added} new MR(s) queued (total: ${syncState.total})`);
  }
  return added;
}

async function resolveJiraTicket(settings, projectPath, mr) {
  if (mr.jiraTicket) return mr.jiraTicket;

  const encoded = encodeURIComponent(projectPath);
  const mrData = await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.mrIid}`);
  const description = mrData.description || '';
  const sourceBranch = mrData.source_branch || '';
  const rawPattern = (settings.jiraPattern || '[A-Z][A-Z0-9]+-\\d+').replace(/^\^/, '').replace(/\$$/, '');
  const pattern = new RegExp(rawPattern);
  const match = description.match(pattern) || sourceBranch.match(pattern);
  if (!match) return null;

  const ticketId = match[0];
  const source = description.match(pattern) ? 'description' : 'source branch';
  addProgress(`Found ${ticketId} in MR !${mr.mrIid} ${source}, updating title...`);
  const newTitle = `${ticketId} ${mrData.title}`;
  await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.mrIid}`, {
    method: 'PUT',
    body: JSON.stringify({ title: newTitle })
  });
  addProgress(`Updated MR !${mr.mrIid} title to: ${newTitle}`);
  return ticketId;
}

async function syncLabelsForMR(settings, projectPath, mr) {
  const result = { mr: mr.title, jiraTicket: mr.jiraTicket, status: 'pending', labels: [], errors: [] };

  try {
    const ticketId = await resolveJiraTicket(settings, projectPath, mr);
    if (!ticketId) {
      result.status = 'skipped';
      result.message = 'No Jira ticket found in title or description';
      return result;
    }
    result.jiraTicket = ticketId;

    addProgress(`Fetching Jira labels for ${ticketId}...`);
    const jiraLabels = await getJiraLabels(settings, ticketId);

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

let cachedSettings = null;

async function drainQueue() {
  if (syncState.running) return;
  if (queue.length === 0) return;

  syncState.running = true;
  syncState.error = null;

  if (!cachedSettings) {
    cachedSettings = await getSettings();
  }

  while (queue.length > 0) {
    const item = queue.shift();
    const result = await syncLabelsForMR(cachedSettings, item.projectPath, item);
    syncState.results.push(result);
    syncState.completed++;
  }

  addProgress('Queue drained. Waiting for new MRs...');
  syncState.running = false;
}

async function runSync(data) {
  cachedSettings = await getSettings();

  if (!cachedSettings.gitlabToken || !cachedSettings.gitlabBaseUrl || !cachedSettings.jiraBaseUrl || !cachedSettings.jiraEmail || !cachedSettings.jiraToken) {
    syncState.error = 'Please configure your API credentials in the extension options.';
    syncState.running = false;
    return;
  }

  if (data) {
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
    enqueue(mrs, projectPath);
  }

  addProgress(`Starting sync...`);
  drainQueue();
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startSync') {
    syncState = { running: false, progress: [], results: [], total: 0, completed: 0, error: null };
    queue = [];
    seen = new Set();
    syncStarted = true;
    runSync(request.data);
    sendResponse({ started: true });
    return false;
  }

  if (request.action === 'addMRs') {
    const { mrs, projectPath } = request.data;
    const added = enqueue(mrs, projectPath);
    if (added > 0 && syncStarted && !syncState.running) {
      drainQueue();
    }
    sendResponse({ queued: added });
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
