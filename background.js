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

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'setDefaultBranch',
    title: 'Set as default branch',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['https://*/*/-/tree/*', 'https://*/*/-/branches*', 'https://*/*/-/commits/*']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'setDefaultBranch') return;

  const pageUrl = info.pageUrl || (tab && tab.url) || '';
  const linkUrl = info.linkUrl || '';

  let branch = null;
  let projectPath = null;

  const projectMatch = pageUrl.match(/https?:\/\/[^/]+\/(.+?)\/-\//);
  if (projectMatch) projectPath = projectMatch[1];

  const treeLinkMatch = linkUrl.match(/\/-\/tree\/(.+?)(?:\?|#|$)/);
  if (treeLinkMatch) {
    branch = decodeURIComponent(treeLinkMatch[1]);
  } else {
    const pageTreeMatch = pageUrl.match(/\/-\/tree\/(.+?)(?:\?|#|$)/);
    if (pageTreeMatch) branch = decodeURIComponent(pageTreeMatch[1]);
  }

  if (!branch || !projectPath) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'GitLab Toolbox',
      message: 'Could not determine branch or project. Navigate to a branch page or right-click a branch link.'
    });
    return;
  }

  (async () => {
    const settings = await getSettings();
    if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'GitLab Toolbox',
        message: 'Please configure GitLab credentials in Settings.'
      });
      return;
    }

    try {
      const encoded = encodeURIComponent(projectPath);
      await gitlabFetch(settings, `projects/${encoded}`, {
        method: 'PUT',
        body: JSON.stringify({ default_branch: branch })
      });
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'GitLab Toolbox',
        message: `Default branch set to: ${branch}`
      });
    } catch (e) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'GitLab Toolbox',
        message: `Failed: ${e.message}`
      });
    }
  })();
});

async function getSettings() {
  return chrome.storage.sync.get({
    gitlabToken: '',
    gitlabBaseUrl: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    jiraToken: '',
    jiraPattern: '[A-Z][A-Z0-9]+-\\d+',
    gitlabProjects: ''
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
  const rawPattern = (settings.jiraPattern || '[A-Z][A-Z0-9]+-\\d+').replace(/^\^/, '').replace(/\$$/, '');
  const pattern = new RegExp(rawPattern);

  if (mr.jiraTicket) return mr.jiraTicket;

  const encoded = encodeURIComponent(projectPath);
  const mrData = await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.mrIid}`);
  const title = mrData.title || '';
  const description = mrData.description || '';
  const sourceBranch = mrData.source_branch || '';

  const titleMatch = title.match(pattern);
  if (titleMatch) return titleMatch[0];

  const descMatch = description.match(pattern);
  const branchMatch = sourceBranch.match(pattern);
  const match = descMatch || branchMatch;
  if (!match) return null;

  const ticketId = match[0];
  const source = descMatch ? 'description' : 'source branch';
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

let jiraTicketOnPage = null;

async function searchGitlabMRsForTicket(settings, ticketId) {
  const projects = (settings.gitlabProjects || '').split('\n').map(p => p.trim()).filter(Boolean);
  const results = [];

  for (const projectPath of projects) {
    const encoded = encodeURIComponent(projectPath);
    try {
      const mrs = await gitlabFetch(settings, `projects/${encoded}/merge_requests?search=${ticketId}&per_page=100`);
      for (const mr of mrs) {
        const rawPattern = (settings.jiraPattern || '[A-Z][A-Z0-9]+-\\d+').replace(/^\^/, '').replace(/\$$/, '');
        const pattern = new RegExp(rawPattern);
        const titleMatch = (mr.title || '').match(pattern);
        const descMatch = (mr.description || '').match(pattern);
        const branchMatch = (mr.source_branch || '').match(pattern);
        const foundTicket = (titleMatch && titleMatch[0]) || (descMatch && descMatch[0]) || (branchMatch && branchMatch[0]);
        if (foundTicket === ticketId) {
          results.push({
            title: mr.title,
            mrIid: mr.iid,
            projectPath,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            state: mr.state,
            mergedAt: mr.merged_at,
            webUrl: mr.web_url
          });
        }
      }
    } catch (e) {}
  }

  if (projects.length === 0) {
    return { error: 'No GitLab projects configured. Add project paths in Settings.' };
  }

  return { ticketId, mrs: results };
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

  if (request.action === 'jiraPageDetected') {
    jiraTicketOnPage = request.ticketId;
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'getPageContext') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ type: 'unknown' }); return; }
      const url = tabs[0].url || '';
      if (url.includes('/browse/') && url.includes('atlassian.net')) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getJiraTicket' }, (response) => {
          if (response && response.ticketId) {
            sendResponse({ type: 'jira', ticketId: response.ticketId });
          } else if (jiraTicketOnPage) {
            sendResponse({ type: 'jira', ticketId: jiraTicketOnPage });
          } else {
            sendResponse({ type: 'unknown' });
          }
        });
      } else if (url.includes('merge_requests')) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'extractMRs' }, (response) => {
          sendResponse({ type: 'gitlab', ...(response || {}) });
        });
      } else {
        sendResponse({ type: 'unknown' });
      }
    });
    return true;
  }

  if (request.action === 'lookupMRs') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ error: 'Please configure GitLab credentials in Settings.' });
        return;
      }
      try {
        const issue = await jiraFetch(settings, `issue/${request.ticketId}?fields=subtasks`);
        const subtasks = (issue.fields.subtasks || []).map(st => ({
          key: st.key,
          summary: st.fields.summary,
          status: st.fields.status.name
        }));

        const parentResult = await searchGitlabMRsForTicket(settings, request.ticketId);
        if (parentResult.error) { sendResponse(parentResult); return; }

        const subtaskResults = [];
        for (const st of subtasks) {
          const stResult = await searchGitlabMRsForTicket(settings, st.key);
          subtaskResults.push({
            ticketId: st.key,
            summary: st.summary,
            status: st.status,
            mrs: stResult.mrs || []
          });
        }

        sendResponse({
          ticketId: request.ticketId,
          mrs: parentResult.mrs || [],
          subtasks: subtaskResults
        });
      } catch (e) {
        const result = await searchGitlabMRsForTicket(settings, request.ticketId);
        sendResponse({ ...result, subtasks: [] });
      }
    })();
    return true;
  }

  if (request.action === 'fixBrokenMRs') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ error: 'Please configure GitLab credentials in Settings.' });
        return;
      }

      const { projectPath } = request;
      const encoded = encodeURIComponent(projectPath);

      try {
        const project = await gitlabFetch(settings, `projects/${encoded}`);
        const defaultBranch = project.default_branch;

        const branches = await gitlabFetch(settings, `projects/${encoded}/repository/branches?per_page=100`);
        const branchNames = new Set(branches.map(b => b.name));

        let page = 1;
        let allOpenMRs = [];
        while (true) {
          const mrs = await gitlabFetch(settings, `projects/${encoded}/merge_requests?state=opened&per_page=100&page=${page}`);
          if (!mrs.length) break;
          allOpenMRs = allOpenMRs.concat(mrs);
          if (mrs.length < 100) break;
          page++;
        }

        const broken = allOpenMRs.filter(mr => !branchNames.has(mr.target_branch));
        if (broken.length === 0) {
          sendResponse({ fixed: 0, defaultBranch, message: 'No broken MRs found.' });
          return;
        }

        let fixed = 0;
        const errors = [];
        for (const mr of broken) {
          try {
            await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.iid}`, {
              method: 'PUT',
              body: JSON.stringify({ target_branch: defaultBranch })
            });
            fixed++;
          } catch (e) {
            errors.push(`!${mr.iid}: ${e.message}`);
          }
        }

        sendResponse({ fixed, total: broken.length, defaultBranch, errors });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }
});
