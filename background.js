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
  chrome.contextMenus.create({
    id: 'syncLabels',
    title: 'Sync Jira Labels',
    contexts: ['page'],
    documentUrlPatterns: ['https://*/*/-/merge_requests*']
  });
  chrome.contextMenus.create({
    id: 'showJiraInfo',
    title: 'Show Jira Tickets Info',
    contexts: ['page'],
    documentUrlPatterns: ['https://*/*/-/merge_requests/*']
  });
  chrome.contextMenus.create({
    id: 'copyForTeams',
    title: 'Copy for Teams',
    contexts: ['page'],
    documentUrlPatterns: ['https://*.atlassian.net/browse/*']
  });
  chrome.contextMenus.create({
    id: 'sendToTeams',
    title: 'Send to Teams',
    contexts: ['page'],
    documentUrlPatterns: ['https://*.atlassian.net/browse/*']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'showJiraInfo') {
    chrome.tabs.sendMessage(tab.id, { action: 'showJiraPanel' });
    return;
  }

  if (info.menuItemId === 'copyForTeams') {
    chrome.tabs.sendMessage(tab.id, { action: 'copyForTeams' });
    return;
  }

  if (info.menuItemId === 'sendToTeams') {
    chrome.tabs.sendMessage(tab.id, { action: 'sendToTeams' });
    return;
  }

  if (info.menuItemId === 'syncLabels') {
    chrome.tabs.sendMessage(tab.id, { action: 'extractMRs' }, (response) => {
      if (!response || !response.mrs || !response.mrs.length || !response.projectPath) return;
      syncState = { running: false, progress: [], results: [], total: 0, completed: 0, error: null };
      queue = [];
      seen = new Set();
      syncStarted = true;
      runSync({ mrs: response.mrs, projectPath: response.projectPath });
    });
    return;
  }

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

async function jiraSearch(settings, jql, fields = 'summary,status', maxResults = 100) {
  const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
  const response = await fetch(`${settings.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/search/jql`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ jql, fields: fields.split(','), maxResults })
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
  if (response.status === 204) return null;
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

async function createGitlabLabel(settings, projectPath, labelName, color) {
  const encoded = encodeURIComponent(projectPath);
  if (!color) color = '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
  return gitlabFetch(settings, `projects/${encoded}/labels`, {
    method: 'POST',
    body: JSON.stringify({ name: labelName, color })
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

const STATUS_LABEL_PREFIX = 'Status: ';

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

    addProgress(`Fetching Jira labels and status for ${ticketId}...`);
    const issue = await jiraFetch(settings, `issue/${ticketId}?fields=labels,status`);
    const jiraLabels = issue.fields.labels || [];
    const jiraStatus = issue.fields.status && issue.fields.status.name;

    const encoded = encodeURIComponent(projectPath);
    const mrData = await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.mrIid}`);
    const existingMrLabels = mrData.labels || [];

    let labelsToApply = mrData.target_branch === 'testing'
      ? ['Testing', ...jiraLabels.filter(l => l !== 'Testing')]
      : jiraLabels.slice();

    // --- Jira status as label (remove old status labels, add current) ---
    const oldStatusLabels = existingMrLabels.filter(l => l.startsWith(STATUS_LABEL_PREFIX));
    const currentStatusLabel = jiraStatus ? `${STATUS_LABEL_PREFIX}${jiraStatus}` : null;

    if (currentStatusLabel && !labelsToApply.includes(currentStatusLabel)) {
      labelsToApply.push(currentStatusLabel);
    }
    addProgress(`Jira status: "${jiraStatus}" → label "${currentStatusLabel}"`);

    result.labels = labelsToApply;

    // Ensure all labels exist in project
    const existingProjectLabels = await getGitlabProjectLabels(settings, projectPath);
    for (const label of labelsToApply) {
      if (!existingProjectLabels.includes(label)) {
        addProgress(`Creating GitLab label: ${label}`);
        try {
          const labelColor = label.startsWith(STATUS_LABEL_PREFIX) ? '#000000' : undefined;
          await createGitlabLabel(settings, projectPath, label, labelColor);
        } catch (e) {
          if (!e.message.includes('409')) {
            result.errors.push(`Failed to create label "${label}": ${e.message}`);
          }
        }
      }
    }

    // Build final label set: existing labels - old status labels + new labels
    const labelsToRemove = oldStatusLabels.filter(l => l !== currentStatusLabel);
    const finalLabels = [
      ...existingMrLabels.filter(l => !labelsToRemove.includes(l) && !labelsToApply.includes(l)),
      ...labelsToApply
    ];

    addProgress(`Syncing labels to MR !${mr.mrIid}...`);
    await gitlabFetch(settings, `projects/${encoded}/merge_requests/${mr.mrIid}`, {
      method: 'PUT',
      body: JSON.stringify({ labels: finalLabels.join(',') })
    });
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
let epicInfoOnPage = null;

async function searchGitlabMRsForTicket(settings, ticketId) {
  const projects = (settings.gitlabProjects || '').split('\n').map(p => p.trim()).filter(Boolean);
  const results = [];

  if (projects.length === 0) {
    return { error: 'No GitLab projects configured. Add project paths in Settings.' };
  }

  for (const projectPath of projects) {
    const encoded = encodeURIComponent(projectPath);
    const seen = new Set();

    const addMR = (mr) => {
      if (seen.has(mr.iid)) return;
      const rawPattern = (settings.jiraPattern || '[A-Z][A-Z0-9]+-\\d+').replace(/^\^/, '').replace(/\$$/, '');
      const pattern = new RegExp(rawPattern);
      const titleMatch = (mr.title || '').match(pattern);
      const descMatch = (mr.description || '').match(pattern);
      const branchMatch = (mr.source_branch || '').match(pattern);
      const foundTicket = (titleMatch && titleMatch[0]) || (descMatch && descMatch[0]) || (branchMatch && branchMatch[0]);
      console.log(`[GitLab Toolbox] addMR !${mr.iid} "${mr.title}" branch=${mr.source_branch} foundTicket=${foundTicket} expected=${ticketId}`);
      if (foundTicket === ticketId) {
        seen.add(mr.iid);
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
    };

    try {
      // Search by title/description
      const mrs = await gitlabFetch(settings, `projects/${encoded}/merge_requests?search=${encodeURIComponent(ticketId)}&state=all&per_page=100`);
      console.log(`[GitLab Toolbox] MR search for "${ticketId}" in ${projectPath}: found ${mrs.length} results`);
      mrs.forEach(addMR);
    } catch (e) {
      console.error(`[GitLab Toolbox] MR search error for "${ticketId}" in ${projectPath}:`, e.message);
    }

    try {
      // Search by source_branch: find branches containing the ticket ID
      const branches = await gitlabFetch(settings, `projects/${encoded}/repository/branches?search=${ticketId}&per_page=100`);
      for (const branch of branches) {
        if (!branch.name.includes(ticketId)) continue;
        try {
          const branchMRs = await gitlabFetch(settings, `projects/${encoded}/merge_requests?source_branch=${encodeURIComponent(branch.name)}&state=all&per_page=100`);
          branchMRs.forEach(addMR);
        } catch (e) {}
      }
    } catch (e) {}
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

  if (request.action === 'epicPageDetected') {
    epicInfoOnPage = { groupPath: request.groupPath, epicIid: request.epicIid };
    sendResponse({ ok: true });
    return false;
  }

  if (request.action === 'getPageContext') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ type: 'unknown' }); return; }
      const url = tabs[0].url || '';
      if (url.includes('atlassian.net')) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getJiraTicket' }, (response) => {
          if (response && response.ticketId) {
            sendResponse({ type: 'jira', ticketId: response.ticketId });
          } else if (jiraTicketOnPage) {
            sendResponse({ type: 'jira', ticketId: jiraTicketOnPage });
          } else {
            sendResponse({ type: 'unknown' });
          }
        });
      } else if (url.includes('/-/epics/')) {
        chrome.tabs.sendMessage(tabs[0].id, { action: 'getEpicInfo' }, (response) => {
          if (response && response.groupPath && response.epicIid) {
            sendResponse({ type: 'epic', groupPath: response.groupPath, epicIid: response.epicIid });
          } else if (epicInfoOnPage) {
            sendResponse({ type: 'epic', ...epicInfoOnPage });
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
        const processedTickets = new Set();
        processedTickets.add(request.ticketId);

        const issue = await jiraFetch(settings, `issue/${request.ticketId}?fields=subtasks,issuetype,issuelinks`);
        let children = (issue.fields.subtasks || []).map(st => ({
          key: st.key,
          summary: st.fields.summary,
          status: st.fields.status.name
        }));

        if (children.length === 0) {
          const childrenMap = new Map();
          const jqlQueries = [
            `parent = ${request.ticketId}`,
            `"Epic Link" = ${request.ticketId}`
          ];
          for (const jql of jqlQueries) {
            try {
              const searchResult = await jiraSearch(settings, jql);
              for (const i of (searchResult.issues || [])) {
                if (!childrenMap.has(i.key)) {
                  childrenMap.set(i.key, { key: i.key, summary: i.fields.summary, status: i.fields.status.name });
                }
              }
            } catch (_) {}
          }
          children = [...childrenMap.values()];
        }

        for (const child of children) {
          processedTickets.add(child.key);
        }

        const relatedMap = new Map();
        for (const link of (issue.fields.issuelinks || [])) {
          const relatedIssue = link.outwardIssue || link.inwardIssue;
          if (!relatedIssue) continue;
          if (processedTickets.has(relatedIssue.key)) continue;
          if (!relatedMap.has(relatedIssue.key)) {
            relatedMap.set(relatedIssue.key, {
              key: relatedIssue.key,
              summary: relatedIssue.fields?.summary || '',
              status: relatedIssue.fields?.status?.name || '',
              linkType: link.type?.outward || link.type?.inward || 'related'
            });
            processedTickets.add(relatedIssue.key);
          }
        }

        const parentResult = await searchGitlabMRsForTicket(settings, request.ticketId);
        if (parentResult.error) { sendResponse(parentResult); return; }

        const subtaskResults = [];
        for (const st of children) {
          const stResult = await searchGitlabMRsForTicket(settings, st.key);
          subtaskResults.push({
            ticketId: st.key,
            summary: st.summary,
            status: st.status,
            mrs: stResult.mrs || []
          });
        }

        const relatedResults = [];
        for (const rel of relatedMap.values()) {
          const relResult = await searchGitlabMRsForTicket(settings, rel.key);

          let relSubtasks = [];
          try {
            const relIssue = await jiraFetch(settings, `issue/${rel.key}?fields=subtasks`);
            let relChildren = (relIssue.fields.subtasks || []).map(st => ({
              key: st.key,
              summary: st.fields.summary,
              status: st.fields.status.name
            }));

            if (relChildren.length === 0) {
              const relChildrenMap = new Map();
              const jqlQueries = [
                `parent = ${rel.key}`,
                `"Epic Link" = ${rel.key}`
              ];
              for (const jql of jqlQueries) {
                try {
                  const searchResult = await jiraSearch(settings, jql);
                  for (const i of (searchResult.issues || [])) {
                    if (!relChildrenMap.has(i.key)) {
                      relChildrenMap.set(i.key, { key: i.key, summary: i.fields.summary, status: i.fields.status.name });
                    }
                  }
                } catch (_) {}
              }
              relChildren = [...relChildrenMap.values()];
            }

            for (const relChild of relChildren) {
              if (processedTickets.has(relChild.key)) continue;
              processedTickets.add(relChild.key);
              const relChildResult = await searchGitlabMRsForTicket(settings, relChild.key);
              relSubtasks.push({
                ticketId: relChild.key,
                summary: relChild.summary,
                status: relChild.status,
                mrs: relChildResult.mrs || []
              });
            }
          } catch (_) {}

          relatedResults.push({
            ticketId: rel.key,
            summary: rel.summary,
            status: rel.status,
            linkType: rel.linkType,
            mrs: relResult.mrs || [],
            subtasks: relSubtasks
          });
        }

        sendResponse({
          ticketId: request.ticketId,
          mrs: parentResult.mrs || [],
          subtasks: subtaskResults,
          related: relatedResults
        });
      } catch (e) {
        const result = await searchGitlabMRsForTicket(settings, request.ticketId);
        sendResponse({ ...result, subtasks: [], related: [] });
      }
    })();
    return true;
  }

  if (request.action === 'lookupEpicMRs') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ error: 'Please configure GitLab credentials in Settings.' });
        return;
      }
      const { groupPath, epicIid } = request;
      try {
        const query = `query {
          namespace(fullPath: "${groupPath}") {
            workItem(iid: "${epicIid}") {
              widgets {
                ... on WorkItemWidgetHierarchy {
                  children {
                    nodes {
                      id
                      iid
                      title
                      state
                      namespace {
                        fullPath
                      }
                      project {
                        fullPath
                      }
                    }
                  }
                }
              }
            }
          }
        }`;

        const graphqlUrl = `${settings.gitlabBaseUrl.replace(/\/$/, '')}/api/graphql`;
        const gqlRes = await fetch(graphqlUrl, {
          method: 'POST',
          headers: {
            'PRIVATE-TOKEN': settings.gitlabToken,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query })
        });
        if (!gqlRes.ok) throw new Error(`GraphQL error: ${gqlRes.status}`);
        const gqlData = await gqlRes.json();

        const widgets = gqlData.data?.namespace?.workItem?.widgets || [];
        const hierarchyWidget = widgets.find(w => w.children);
        const children = hierarchyWidget?.children?.nodes || [];

        if (children.length === 0) {
          const encodedGroup = encodeURIComponent(groupPath);
          let page = 1;
          let allIssues = [];
          while (true) {
            const issues = await gitlabFetch(settings, `groups/${encodedGroup}/epics/${epicIid}/issues?per_page=100&page=${page}`);
            if (!issues.length) break;
            allIssues = allIssues.concat(issues);
            if (issues.length < 100) break;
            page++;
          }
          const issueResults = [];
          for (const issue of allIssues) {
            const encodedProject = encodeURIComponent(issue.project_id);
            let relatedMRs = [];
            try {
              relatedMRs = await gitlabFetch(settings, `projects/${encodedProject}/issues/${issue.iid}/related_merge_requests`);
            } catch (_) {
              try {
                relatedMRs = await gitlabFetch(settings, `projects/${encodedProject}/issues/${issue.iid}/closed_by`);
              } catch (_) {}
            }
            const mrs = relatedMRs.map(mr => ({
              title: mr.title,
              mrIid: mr.iid,
              projectPath: mr.references?.full?.split('!')[0] || `project:${issue.project_id}`,
              sourceBranch: mr.source_branch,
              targetBranch: mr.target_branch,
              state: mr.state,
              mergedAt: mr.merged_at,
              webUrl: mr.web_url
            }));
            issueResults.push({
              issueIid: issue.iid,
              issueTitle: issue.title,
              issueState: issue.state,
              webUrl: issue.web_url,
              mrs
            });
          }
          sendResponse({ type: 'epic', groupPath, epicIid, issues: issueResults });
          return;
        }

        const issueResults = [];
        for (const child of children) {
          const projectPath = child.project?.fullPath;
          if (!projectPath) continue;
          const encodedProject = encodeURIComponent(projectPath);
          let relatedMRs = [];
          try {
            relatedMRs = await gitlabFetch(settings, `projects/${encodedProject}/issues/${child.iid}/related_merge_requests`);
          } catch (_) {
            try {
              relatedMRs = await gitlabFetch(settings, `projects/${encodedProject}/issues/${child.iid}/closed_by`);
            } catch (_) {}
          }
          const mrs = relatedMRs.map(mr => ({
            title: mr.title,
            mrIid: mr.iid,
            projectPath: mr.references?.full?.split('!')[0] || projectPath,
            sourceBranch: mr.source_branch,
            targetBranch: mr.target_branch,
            state: mr.state,
            mergedAt: mr.merged_at,
            webUrl: mr.web_url
          }));
          issueResults.push({
            issueIid: child.iid,
            issueTitle: child.title,
            issueState: child.state.toLowerCase(),
            webUrl: `${settings.gitlabBaseUrl.replace(/\/$/, '')}/${projectPath}/-/issues/${child.iid}`,
            mrs
          });
        }

        sendResponse({ type: 'epic', groupPath, epicIid, issues: issueResults });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'fetchLatestPatch') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ patch: 1 });
        return;
      }
      const { projectPath, date, prefix } = request;
      const encoded = encodeURIComponent(projectPath);
      const searchPattern = `v${date}-${prefix}`;
      try {
        const tags = await gitlabFetch(settings, `projects/${encoded}/repository/tags?search=${encodeURIComponent(searchPattern)}&per_page=100`);
        let maxPatch = 0;
        const regex = new RegExp(`v${date.replace(/\./g, '\\.')}-${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)`);
        for (const tag of tags) {
          const match = tag.name.match(regex);
          if (match) {
            const num = parseInt(match[1], 10);
            if (num > maxPatch) maxPatch = num;
          }
        }
        sendResponse({ patch: maxPatch + 1 });
      } catch (_) {
        sendResponse({ patch: 1 });
      }
    })();
    return true;
  }

  if (request.action === 'createTags') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ error: 'Please configure GitLab credentials in Settings.' });
        return;
      }
      const { projectPath, tags, force } = request;
      const encoded = encodeURIComponent(projectPath);
      const results = [];
      for (const { tagName, ref, message } of tags) {
        try {
          if (force) {
            try {
              await gitlabFetch(settings, `projects/${encoded}/repository/tags/${encodeURIComponent(tagName)}`, { method: 'DELETE' });
            } catch (e) {}
          }
          await gitlabFetch(settings, `projects/${encoded}/repository/tags`, {
            method: 'POST',
            body: JSON.stringify({ tag_name: tagName, ref, message: message || '' })
          });
          results.push({ tagName, status: 'success' });
        } catch (e) {
          results.push({ tagName, status: 'error', message: e.message });
        }
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (request.action === 'searchOldTags') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        sendResponse({ error: 'Please configure GitLab credentials in Settings.' });
        return;
      }
      const { projectPath, days, pattern } = request;
      const encoded = encodeURIComponent(projectPath);
      const cutoff = new Date(Date.now() - days * 86400000);
      try {
        let allTags = [];
        let page = 1;
        while (true) {
          const searchParam = pattern ? `&search=${encodeURIComponent(pattern)}` : '';
          const tags = await gitlabFetch(settings, `projects/${encoded}/repository/tags?per_page=100&page=${page}${searchParam}`);
          if (!tags || tags.length === 0) break;
          allTags = allTags.concat(tags);
          if (tags.length < 100) break;
          page++;
        }
        const oldTags = allTags.filter(tag => {
          const commitDate = new Date(tag.commit?.created_at || tag.commit?.committed_date || 0);
          return commitDate < cutoff;
        }).map(tag => ({ name: tag.name, date: tag.commit?.created_at || tag.commit?.committed_date }));
        sendResponse({ tags: oldTags });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'deleteOldTags') {
    (async () => {
      const settings = await getSettings();
      if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
        await chrome.storage.local.set({ deleteTagsProgress: { running: false, total: 0, deleted: 0, errors: 0, results: [], error: 'Please configure GitLab credentials in Settings.' } });
        return;
      }
      const { projectPath, tagNames } = request;
      const encoded = encodeURIComponent(projectPath);

      const results = [];
      await chrome.storage.local.set({ deleteTagsProgress: { running: true, total: tagNames.length, deleted: 0, errors: 0, results: [] } });

      for (const tagName of tagNames) {
        try {
          await gitlabFetch(settings, `projects/${encoded}/repository/tags/${encodeURIComponent(tagName)}`, { method: 'DELETE' });
          results.push({ tagName, status: 'success' });
        } catch (e) {
          results.push({ tagName, status: 'error', message: e.message });
        }
        await chrome.storage.local.set({
          deleteTagsProgress: {
            running: true,
            total: tagNames.length,
            deleted: results.filter(r => r.status === 'success').length,
            errors: results.filter(r => r.status === 'error').length,
            results
          }
        });
      }

      await chrome.storage.local.set({
        deleteTagsProgress: {
          running: false,
          total: tagNames.length,
          deleted: results.filter(r => r.status === 'success').length,
          errors: results.filter(r => r.status === 'error').length,
          results
        }
      });
    })();
    sendResponse({ started: true });
    return false;
  }

  if (request.action === 'checkSubtasksStatus') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      try {
        const issue = await jiraFetch(settings, `issue/${request.ticketId}?fields=status,subtasks`);
        const currentStatus = issue.fields.status.name;
        const subtasks = issue.fields.subtasks || [];
        const pendingSubtasks = subtasks
          .filter(st => st.fields.status.name.toUpperCase() !== 'DONE')
          .map(st => ({ key: st.key, status: st.fields.status.name }));
        sendResponse({ currentStatus, pendingSubtasks, totalSubtasks: subtasks.length });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'transitionSubtasks') {
    (async () => {
      const settings = await getSettings();
      const results = [];
      for (const key of request.subtaskKeys) {
        try {
          const transitions = await jiraFetch(settings, `issue/${key}/transitions`);
          const target = transitions.transitions.find(t => t.name.toUpperCase() === request.targetStatus.toUpperCase());
          if (!target) {
            results.push({ key, error: `No transition to "${request.targetStatus}"` });
            continue;
          }
          const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
          const res = await fetch(`${settings.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${key}/transitions`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ transition: { id: target.id } })
          });
          if (!res.ok) throw new Error(`${res.status}`);
          results.push({ key, success: true });
        } catch (e) {
          results.push({ key, error: e.message });
        }
      }
      sendResponse({ results });
    })();
    return true;
  }

  if (request.action === 'checkParentStatus') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      try {
        const issue = await jiraFetch(settings, `issue/${request.ticketId}?fields=parent,status`);
        const parent = issue.fields.parent;
        if (!parent) {
          sendResponse({ hasParent: false });
          return;
        }
        const parentIssue = await jiraFetch(settings, `issue/${parent.key}?fields=status`);
        sendResponse({
          hasParent: true,
          parentKey: parent.key,
          parentStatus: parentIssue.fields.status.name,
          childStatus: issue.fields.status.name
        });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'transitionChild') {
    (async () => {
      const settings = await getSettings();
      try {
        const transitions = await jiraFetch(settings, `issue/${request.ticketId}/transitions`);
        const target = transitions.transitions.find(t => t.name.toUpperCase() === request.targetStatus.toUpperCase());
        if (!target) {
          sendResponse({ error: `No transition found to status "${request.targetStatus}"` });
          return;
        }
        const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
        const res = await fetch(`${settings.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${request.ticketId}/transitions`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ transition: { id: target.id } })
        });
        if (!res.ok) throw new Error(`Transition failed: ${res.status}`);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'getJiraTicketDetails') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      try {
        const issue = await jiraFetch(settings, `issue/${request.ticketId}?fields=summary,status,assignee,labels,parent`);
        const result = {
          key: request.ticketId,
          title: issue.fields.summary,
          status: issue.fields.status?.name,
          assignee: issue.fields.assignee?.displayName || null,
          labels: issue.fields.labels || [],
          parent: null
        };
        if (issue.fields.parent) {
          const parent = await jiraFetch(settings, `issue/${issue.fields.parent.key}?fields=summary,status,assignee`);
          result.parent = {
            key: parent.key,
            title: parent.fields.summary,
            status: parent.fields.status?.name,
            assignee: parent.fields.assignee?.displayName || null
          };
        }
        sendResponse(result);
      } catch (e) {
        sendResponse({ error: e.message });
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

        const broken = allOpenMRs.filter(mr => !branchNames.has(mr.target_branch) && /^releases\//.test(mr.target_branch));
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

  if (request.action === 'getJiraTransitions') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      try {
        const transitions = await jiraFetch(settings, `issue/${request.ticketId}/transitions`);
        sendResponse({ transitions: transitions.transitions || [] });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'getJiraAssignees') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      try {
        const projectKey = request.ticketId.split('-')[0];
        const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
        const res = await fetch(`${settings.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/user/assignable/search?project=${projectKey}&maxResults=100`, {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Accept': 'application/json'
          }
        });
        if (!res.ok) throw new Error(`Jira API error: ${res.status}`);
        const users = await res.json();
        const { recentAssignees = [] } = await chrome.storage.local.get('recentAssignees');
        sendResponse({ users, recentAssignees });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === 'jiraQuickAction') {
    (async () => {
      const settings = await getSettings();
      if (!settings.jiraBaseUrl || !settings.jiraEmail || !settings.jiraToken) {
        sendResponse({ error: 'Please configure Jira credentials in Settings.' });
        return;
      }
      const credentials = btoa(`${settings.jiraEmail}:${settings.jiraToken}`);
      const baseUrl = settings.jiraBaseUrl.replace(/\/$/, '');
      const results = { status: null, assignee: null, comment: null };

      try {
        if (request.transitionId) {
          const res = await fetch(`${baseUrl}/rest/api/3/issue/${request.ticketId}/transitions`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ transition: { id: request.transitionId } })
          });
          if (!res.ok) throw new Error(`Status change failed: ${res.status}`);
          results.status = 'success';
        }

        if (request.assigneeId) {
          const res = await fetch(`${baseUrl}/rest/api/3/issue/${request.ticketId}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ fields: { assignee: { accountId: request.assigneeId } } })
          });
          if (!res.ok) throw new Error(`Assignee change failed: ${res.status}`);
          results.assignee = 'success';

          const { recentAssignees = [] } = await chrome.storage.local.get('recentAssignees');
          const updated = [
            { accountId: request.assigneeId, displayName: request.assigneeName },
            ...recentAssignees.filter(a => a.accountId !== request.assigneeId)
          ].slice(0, 10);
          await chrome.storage.local.set({ recentAssignees: updated });
        }

        if (request.comment) {
          let content = [];
          if (request.tagAssignee && request.assigneeId) {
            content.push({
              type: 'mention',
              attrs: {
                id: request.assigneeId,
                text: `@${request.assigneeName || 'user'}`,
                accessLevel: ''
              }
            });
            content.push({ type: 'text', text: ' ' });
          }
          content.push({ type: 'text', text: request.comment });
          
          const res = await fetch(`${baseUrl}/rest/api/3/issue/${request.ticketId}/comment`, {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${credentials}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              body: {
                type: 'doc',
                version: 1,
                content: [{ type: 'paragraph', content }]
              }
            })
          });
          if (!res.ok) throw new Error(`Comment failed: ${res.status}`);
          results.comment = 'success';
        }

        sendResponse({ success: true, results });
      } catch (e) {
        sendResponse({ error: e.message, results });
      }
    })();
    return true;
  }
});
