const statusEl = document.getElementById('status');
const gitlabView = document.getElementById('gitlab-view');
const jiraView = document.getElementById('jira-view');
const tagView = document.getElementById('tag-view');
const mrListEl = document.getElementById('mr-list');
const syncBtn = document.getElementById('sync-btn');
const progressEl = document.getElementById('progress');
const resultsEl = document.getElementById('results');
const jiraTicketEl = document.getElementById('jira-ticket');
const lookupBtn = document.getElementById('lookup-btn');
const jiraResultsEl = document.getElementById('jira-results');
const optionsLink = document.getElementById('options-link');
const mrButtons = ['create-mr-testing-btn','create-mr-main-btn','create-mr-main-to-testing-btn','create-mr-main-to-release-btn'].map(id => document.getElementById(id));

let extractedData = null;
let pollTimer = null;
let storedReleaseBranch = 'main';

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.style.display = 'block';
}

function setFooterTagMode(enabled) {
  const footerGrid = document.querySelector('.footer-grid');
  if (footerGrid) footerGrid.classList.toggle('tag-mode', enabled);
}

function showGitlabView() {
  gitlabView.style.display = '';
  jiraView.style.display = 'none';
  tagView.style.display = 'none';
  mrButtons.forEach(b => b && (b.style.display = ''));
  setFooterTagMode(false);
}

function showJiraView() {
  gitlabView.style.display = 'none';
  jiraView.style.display = '';
  tagView.style.display = 'none';
  mrButtons.forEach(b => b && (b.style.display = ''));
  setFooterTagMode(false);
}

async function showTagView() {
  gitlabView.style.display = 'none';
  jiraView.style.display = 'none';
  tagView.style.display = '';
  statusEl.style.display = 'none';
  mrButtons.forEach(b => b && (b.style.display = 'none'));
  setFooterTagMode(true);

  const dateInput = document.getElementById('tag-date');
  if (!dateInput.value) {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    dateInput.value = `${yyyy}.${mm}.${dd}`;
  }

  const branchRadios = document.querySelectorAll('input[name="tag-source-branch"]');
  const branchOtherInput = document.getElementById('tag-source-branch-other');

  function handleBranchChange() {
    const selected = document.querySelector('input[name="tag-source-branch"]:checked');
    if (!selected) return;
    const envInput = document.getElementById('tag-env');
    if (selected.value === 'main') {
      envInput.value = '';
    } else if (selected.value === 'release') {
      envInput.value = 'stag';
    }
    branchOtherInput.style.display = selected.value === 'other' ? '' : 'none';
    renderTagPreview();
  }

  branchRadios.forEach(radio => radio.addEventListener('change', handleBranchChange));
  branchOtherInput.addEventListener('input', renderTagPreview);
  handleBranchChange();

  // Load recent services (non-blocking)
  const recentServicesContainer = document.getElementById('tag-recent-services');
  chrome.storage.local.get({ recentServices: [] }, (data) => {
    recentServicesContainer.innerHTML = '';
    (data.recentServices || []).sort((a, b) => a.localeCompare(b)).forEach(service => {
      const item = document.createElement('div');
      item.className = 'recent-service-item';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.id = `recent-svc-${service}`;
      checkbox.value = service;
      checkbox.addEventListener('change', () => updateServicesFromCheckboxes());
      const label = document.createElement('label');
      label.htmlFor = checkbox.id;
      label.textContent = service;
      item.appendChild(checkbox);
      item.appendChild(label);
      recentServicesContainer.appendChild(item);
    });
  });

  renderTagPreview();

  // Async operations that don't block UI
  Promise.all([
    chrome.storage.sync.get({ defaultPatchPrefix: 'p' }),
    chrome.tabs.query({ active: true, currentWindow: true })
  ]).then(async ([{ defaultPatchPrefix }, [tab]]) => {
    const prefixInput = document.getElementById('tag-patch-prefix');
    if (prefixInput.value === 'p') {
      prefixInput.value = defaultPatchPrefix;
    }

    let projectPath = null;
    if (tab && tab.url) {
      const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
      const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
      projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);
      
      if (projectPath) {
        const settings = await chrome.storage.sync.get({ gitlabToken: '', gitlabBaseUrl: '' });
        if (settings.gitlabToken && settings.gitlabBaseUrl) {
          try {
            const encoded = encodeURIComponent(projectPath);
            const res = await fetch(`${settings.gitlabBaseUrl.replace(/\/$/, '')}/api/v4/projects/${encoded}`, {
              headers: { 'PRIVATE-TOKEN': settings.gitlabToken }
            });
            if (res.ok) {
              const project = await res.json();
              storedReleaseBranch = project.default_branch || 'main';
            }
          } catch (_) {}
        }
      }

      await autoFetchPatch(projectPath);
      renderTagPreview();
    }

    // Pre-fill tag message (non-blocking)
    const messageInput = document.getElementById('tag-message');
    if (!messageInput.value && tab && tab.url && /\/-\/merge_requests\/\d+/.test(tab.url)) {
      try {
        const { jiraPattern, jiraTicketPattern } = await chrome.storage.sync.get({
          jiraPattern: '[A-Z][A-Z0-9]+-\\d+',
          jiraTicketPattern: ''
        });
        const rawPattern = (jiraTicketPattern || jiraPattern || '[A-Z][A-Z0-9]+-\\d+')
          .replace(/^\^/, '').replace(/\$$/, '');
        const [{ result: ticketId }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (patternStr) => {
            const pattern = new RegExp(patternStr);
            const globalPattern = new RegExp(patternStr, 'g');

            function firstMatch(text) {
              if (!text) return null;
              const m = text.match(pattern);
              return m ? m[0] : null;
            }

            const titleEl = document.querySelector(
              '.detail-page-header .title, ' +
              '.merge-request-details .title, ' +
              '[data-testid="title-content"], ' +
              '.page-title, ' +
              '.title-container .title, ' +
              '.issue-title-text, ' +
              'h2.gl-font-size-h-display, ' +
              '.merge-request .detail-page-header-body'
            );
            const fromTitle = firstMatch(titleEl?.textContent?.trim());
            if (fromTitle) return fromTitle;

            const descEl = document.querySelector(
              '.description .md, ' +
              '.description-holder .md, ' +
              '[data-testid="description-content"] .md, ' +
              '.js-task-list-container .md, ' +
              '.merge-request-description .md, ' +
              '.detail-page-description .md, ' +
              '#content-body .description'
            );
            const fromDesc = firstMatch(descEl?.textContent?.trim());
            if (fromDesc) return fromDesc;

            const branchEl = document.querySelector(
              '.ref-container .ref-name, [data-testid="ref-name"], .js-source-branch'
            );
            const fromBranch = firstMatch(branchEl?.textContent?.trim());
            if (fromBranch) return fromBranch;

            const scope = document.querySelector('.merge-request, #content-body, main') || document.body;
            const matches = scope.innerText.match(globalPattern);
            return matches && matches.length ? matches[0] : null;
          },
          args: [rawPattern]
        });
        if (ticketId) {
          messageInput.value = ticketId;
        }
      } catch (_) {}
    }
  }).catch(() => {});
}

function getSelectedBranch() {
  const selected = document.querySelector('input[name="tag-source-branch"]:checked');
  if (!selected) return '';
  if (selected.value === 'main') return 'main';
  if (selected.value === 'release') return storedReleaseBranch;
  return document.getElementById('tag-source-branch-other').value.trim();
}

async function autoFetchPatch(projectPathOverride) {
  const patchInput = document.getElementById('tag-patch');
  const date = document.getElementById('tag-date').value.trim();
  const prefix = document.getElementById('tag-patch-prefix').value.trim() || 'p';

  if (!date) return;

  let projectPath = projectPathOverride;
  if (!projectPath) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
        const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
        projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);
      }
    } catch (_) {}
  }

  if (!projectPath) return;

  patchInput.placeholder = '…';
  try {
    const result = await chrome.runtime.sendMessage({
      action: 'fetchLatestPatch',
      projectPath,
      date,
      prefix
    });
    patchInput.value = result.patch;
    renderTagPreview();
  } catch (_) {
    patchInput.placeholder = 'auto';
  }
}

function buildTagNames() {
  const servicesRaw = document.getElementById('tag-services').value;
  const date = document.getElementById('tag-date').value.trim();
  const patch = document.getElementById('tag-patch').value.trim() || '1';
  const prefix = document.getElementById('tag-patch-prefix').value.trim() || 'p';
  const env = document.getElementById('tag-env').value.trim();

  const version = `v${date}-${prefix}${patch}${env ? '-' + env : ''}`;

  const services = servicesRaw
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (services.length === 0) {
    return [{ service: null, tagName: version }];
  }

  return services.map(service => ({
    service,
    tagName: `${service}-${version}`
  }));
}

function renderTagPreview() {
  const previewEl = document.getElementById('tag-preview');
  const tags = buildTagNames();
  previewEl.innerHTML = '';

  if (tags.length === 0 || !document.getElementById('tag-date').value.trim()) {
    previewEl.innerHTML = '<span style="font-size:11px;color:#aaa;font-style:italic">Tag names will appear here…</span>';
    return;
  }

  tags.forEach(({ tagName }) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = tagName;
    previewEl.appendChild(chip);
  });
}

['tag-services', 'tag-date', 'tag-patch', 'tag-patch-prefix', 'tag-env'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', renderTagPreview);
});

function updateServicesFromCheckboxes() {
  const servicesInput = document.getElementById('tag-services');
  const checkboxes = document.querySelectorAll('#tag-recent-services input[type="checkbox"]:checked');
  const selected = Array.from(checkboxes).map(cb => cb.value);
  const current = servicesInput.value.split(',').map(s => s.trim()).filter(Boolean);
  const merged = [...new Set([...selected, ...current.filter(s => !document.getElementById(`recent-svc-${s}`))])];
  servicesInput.value = merged.join(', ');
  renderTagPreview();
}

document.getElementById('create-tags-btn-footer').addEventListener('click', () => {
  showTagView();
});

document.getElementById('create-tags-btn').addEventListener('click', async () => {
  const sourceBranch = getSelectedBranch();
  const message = document.getElementById('tag-message').value.trim();
  const tagResultsEl = document.getElementById('tag-results');
  const btn = document.getElementById('create-tags-btn');

  tagResultsEl.innerHTML = '';
  statusEl.style.display = 'none';

  const settings = await chrome.storage.sync.get({ gitlabToken: '', gitlabBaseUrl: '' });
  if (!settings.gitlabToken || !settings.gitlabBaseUrl) {
    setStatus('Please configure GitLab credentials in Settings.', 'error');
    return;
  }

  if (!sourceBranch) {
    setStatus('Source branch is required.', 'error');
    return;
  }

  const tags = buildTagNames();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    setStatus('Cannot determine the active tab URL.', 'error');
    return;
  }

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!projectPath) {
    setStatus('Navigate to a GitLab project page first.', 'error');
    return;
  }

  const payload = tags.map(({ tagName }) => ({
    tagName,
    ref: sourceBranch,
    message: message || ''
  }));

  btn.disabled = true;
  btn.textContent = `Creating 0/${payload.length}…`;

  try {
    const forceCreate = document.getElementById('tag-force-create').checked;
    const result = await chrome.runtime.sendMessage({
      action: 'createTags',
      projectPath,
      tags: payload,
      force: forceCreate
    });

    if (result.error) {
      setStatus(result.error, 'error');
      btn.disabled = false;
      btn.textContent = 'Create Tags';
      return;
    }

    let successCount = 0;
    result.results.forEach(({ tagName, status, message: errMsg }, i) => {
      if (status === 'success') successCount++;
      btn.textContent = `Creating ${i + 1}/${payload.length}…`;

      const item = document.createElement('div');
      item.className = `result-item ${status}`;
      item.innerHTML = status === 'success'
        ? `<strong>${tagName}</strong> — created successfully`
        : `<strong>${tagName}</strong> — ${errMsg || 'unknown error'}`;
      tagResultsEl.appendChild(item);
    });

    const total = result.results.length;
    setStatus(
      `Done: ${successCount}/${total} tag(s) created.`,
      successCount === total ? 'success' : 'error'
    );

    // Save services to recent services
    if (successCount > 0) {
      const servicesRaw = document.getElementById('tag-services').value;
      const services = servicesRaw.split(',').map(s => s.trim()).filter(Boolean);
      if (services.length > 0) {
        chrome.storage.local.get({ recentServices: [] }, (data) => {
          const existing = new Set(data.recentServices || []);
          services.forEach(s => existing.add(s));
          const updated = [...existing].slice(0, 20);
          chrome.storage.local.set({ recentServices: updated });
        });
      }
    }
  } catch (e) {
    setStatus(`Failed: ${e.message}`, 'error');
  }

  btn.disabled = false;
  btn.textContent = 'Create Tags';
});

let foundOldTags = [];

document.getElementById('search-old-tags-btn').addEventListener('click', async () => {
  const days = parseInt(document.getElementById('delete-tags-days').value) || 30;
  const pattern = document.getElementById('delete-tags-pattern').value.trim();
  const resultsEl = document.getElementById('delete-tags-results');
  const deleteBtn = document.getElementById('delete-old-tags-btn');
  const searchBtn = document.getElementById('search-old-tags-btn');

  resultsEl.innerHTML = '';
  deleteBtn.disabled = true;
  foundOldTags = [];

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) {
    setStatus('Cannot determine the active tab URL.', 'error');
    return;
  }

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!projectPath) {
    setStatus('Navigate to a GitLab project page first.', 'error');
    return;
  }

  searchBtn.disabled = true;
  searchBtn.textContent = '🔍 Searching...';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'searchOldTags',
      projectPath,
      days,
      pattern
    });

    if (result.error) {
      setStatus(result.error, 'error');
    } else {
      foundOldTags = result.tags || [];
      if (foundOldTags.length === 0) {
        resultsEl.innerHTML = '<div class="result-item success">No tags found matching criteria.</div>';
      } else {
        resultsEl.innerHTML = `<div class="result-item" style="font-weight:600;margin-bottom:4px">Found ${foundOldTags.length} tag(s) older than ${days} days:</div>` +
          foundOldTags.map(t => `<div class="result-item" style="font-size:11px">${t.name} <span style="color:#999">(${new Date(t.date).toLocaleDateString()})</span></div>`).join('');
        deleteBtn.disabled = false;
      }
    }
  } catch (e) {
    setStatus(`Failed: ${e.message}`, 'error');
  }

  searchBtn.disabled = false;
  searchBtn.textContent = '🔍 Search Tags';
});

document.getElementById('delete-old-tags-btn').addEventListener('click', async () => {
  if (foundOldTags.length === 0) return;

  if (!confirm(`Are you sure you want to delete ${foundOldTags.length} tag(s)? This cannot be undone.`)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const projectMatch = tab.url.match(/https?:\/\/([^/]+)\/(.+?)\/-\//);
  const rootMatch = !projectMatch && tab.url.match(/https?:\/\/([^/]+)\/(.+?)(?:\?|#|$)/);
  const projectPath = projectMatch ? projectMatch[2] : (rootMatch ? rootMatch[2].replace(/\/$/, '') : null);

  if (!projectPath) return;

  const deleteBtn = document.getElementById('delete-old-tags-btn');
  const resultsEl = document.getElementById('delete-tags-results');
  deleteBtn.disabled = true;
  deleteBtn.textContent = `🗑 Deleting 0/${foundOldTags.length}...`;

  await chrome.storage.local.remove('deleteTagsProgress');

  chrome.runtime.sendMessage({
    action: 'deleteOldTags',
    projectPath,
    tagNames: foundOldTags.map(t => t.name)
  });

  // Poll progress from storage
  const pollInterval = setInterval(async () => {
    const { deleteTagsProgress } = await chrome.storage.local.get('deleteTagsProgress');
    if (!deleteTagsProgress) return;

    const done = deleteTagsProgress.deleted + deleteTagsProgress.errors;
    deleteBtn.textContent = `🗑 Deleting ${done}/${deleteTagsProgress.total}...`;

    if (!deleteTagsProgress.running) {
      clearInterval(pollInterval);
      resultsEl.innerHTML = '';
      deleteTagsProgress.results.forEach(r => {
        const item = document.createElement('div');
        item.className = `result-item ${r.status}`;
        item.innerHTML = r.status === 'success'
          ? `<strong>${r.tagName}</strong> — deleted`
          : `<strong>${r.tagName}</strong> — ${r.message || 'failed'}`;
        resultsEl.appendChild(item);
      });
      setStatus(`Deleted ${deleteTagsProgress.deleted}/${deleteTagsProgress.total} tag(s).`, deleteTagsProgress.errors === 0 ? 'success' : 'error');
      foundOldTags = [];
      deleteBtn.disabled = true;
      deleteBtn.textContent = '🗑 Delete Found Tags';
      await chrome.storage.local.remove('deleteTagsProgress');
    }
  }, 500);
});

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
    const isRelease = /^releases?\//.test(mr.targetBranch);
    const isOpen = mr.state === 'opened';
    const envBadge = /^(main|master)$/.test(mr.targetBranch) ? '<span class="mr-env-badge prod">PROD</span>'
      : isRelease ? '<span class="mr-env-badge uat">UAT</span>'
      : /^(testing|develop|dev)$/.test(mr.targetBranch) ? '<span class="mr-env-badge dev">DEV</span>' : '';
    const item = document.createElement('div');
    item.className = 'mr-lookup-item' + (isRelease ? ' release-target' : '') + (isOpen ? ' open-mr' : '');
    item.dataset.mrState = mr.state;
    item.innerHTML = `
      <div class="mr-title"><a href="#" data-url="${mr.webUrl}">!${mr.mrIid} ${mr.title}</a> ${envBadge}</div>
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

  const relatedMRCount = (data.related || []).reduce((sum, rel) => sum + rel.mrs.length + (rel.subtasks || []).reduce((s, st) => s + st.mrs.length, 0), 0);
  const totalMRs = (data.mrs || []).length + (data.subtasks || []).reduce((sum, st) => sum + st.mrs.length, 0) + relatedMRCount;
  const subtaskCount = (data.subtasks || []).length;
  const relatedCount = (data.related || []).length;

  if (totalMRs === 0 && subtaskCount === 0 && relatedCount === 0) {
    setStatus(`No merge requests found for ${data.ticketId}`, 'info');
    return;
  }

  let statusParts = [`Found ${totalMRs} MR(s) for ${data.ticketId}`];
  if (subtaskCount > 0) statusParts.push(`${subtaskCount} subtask(s)`);
  if (relatedCount > 0) statusParts.push(`${relatedCount} related`);
  setStatus(statusParts.join(' + '), 'success');

  const allTicketIds = [];
  if (data.mrs && data.mrs.length > 0) allTicketIds.push(data.ticketId);
  if (data.subtasks) data.subtasks.forEach(st => allTicketIds.push(st.ticketId));
  if (data.related) data.related.forEach(rel => {
    allTicketIds.push(rel.ticketId);
    if (rel.subtasks) rel.subtasks.forEach(relSt => allTicketIds.push(relSt.ticketId));
  });

  const allMRs = [
    ...(data.mrs || []),
    ...(data.subtasks || []).flatMap(st => st.mrs),
    ...(data.related || []).flatMap(rel => [...rel.mrs, ...(rel.subtasks || []).flatMap(relSt => relSt.mrs)])
  ];
  const states = [...new Set(allMRs.map(mr => mr.state))];

  const filterRow = document.createElement('div');
  filterRow.className = 'mr-filter-row';

  if (allTicketIds.length > 1) {
    const filter = document.createElement('select');
    filter.className = 'mr-filter-dropdown';
    filter.dataset.filterType = 'ticket';
    filter.innerHTML = `<option value="">All tickets (${allTicketIds.length})</option>` +
      allTicketIds.map(id => `<option value="${id}">${id}</option>`).join('');
    filter.addEventListener('change', () => applyFilters());
    filterRow.appendChild(filter);
  }

  const stateFilter = document.createElement('select');
  stateFilter.className = 'mr-filter-dropdown';
  stateFilter.dataset.filterType = 'state';
  stateFilter.innerHTML = `<option value="">All states</option>` +
    states.map(s => `<option value="${s}">${s}</option>`).join('');
  stateFilter.addEventListener('change', () => applyFilters());
  filterRow.appendChild(stateFilter);

  jiraResultsEl.appendChild(filterRow);

  function applyFilters() {
    const ticketVal = filterRow.querySelector('[data-filter-type="ticket"]')?.value || '';
    const stateVal = filterRow.querySelector('[data-filter-type="state"]')?.value || '';
    jiraResultsEl.querySelectorAll('.lookup-section').forEach(s => {
      const ticketMatch = !ticketVal || s.dataset.ticketId === ticketVal;
      s.style.display = ticketMatch ? '' : 'none';
      if (ticketMatch) {
        s.querySelectorAll('.mr-lookup-item').forEach(item => {
          item.style.display = (!stateVal || item.dataset.mrState === stateVal) ? '' : 'none';
        });
      }
    });
  }

  if (data.mrs && data.mrs.length > 0) {
    const section = document.createElement('div');
    section.className = 'lookup-section';
    section.dataset.ticketId = data.ticketId;
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
      section.dataset.ticketId = st.ticketId;
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

  if (data.related && data.related.length > 0) {
    const relatedHeader = document.createElement('div');
    relatedHeader.className = 'related-header';
    relatedHeader.textContent = 'Related Tickets';
    jiraResultsEl.appendChild(relatedHeader);

    data.related.forEach(rel => {
      const section = document.createElement('div');
      section.className = 'lookup-section related-section';
      section.dataset.ticketId = rel.ticketId;
      section.innerHTML = `<div class="lookup-section-header">${rel.ticketId} <span class="link-type">${rel.linkType}</span> <span class="subtask-summary">${rel.summary}</span> <span class="subtask-status">${rel.status}</span></div>`;
      if (rel.mrs.length > 0) {
        const alert = getMissingReleaseMRAlert(rel.ticketId, rel.mrs);
        if (alert) section.appendChild(alert);
        renderMRItems(section, rel.mrs);
      } else {
        const empty = document.createElement('div');
        empty.className = 'no-mrs';
        empty.textContent = 'No merge requests found';
        section.appendChild(empty);
      }

      if (rel.subtasks && rel.subtasks.length > 0) {
        rel.subtasks.forEach(relSt => {
          const subSection = document.createElement('div');
          subSection.className = 'lookup-section related-subtask-section';
          subSection.dataset.ticketId = relSt.ticketId;
          subSection.innerHTML = `<div class="lookup-section-header">${relSt.ticketId} <span class="subtask-summary">${relSt.summary}</span> <span class="subtask-status">${relSt.status}</span></div>`;
          if (relSt.mrs.length > 0) {
            const alert = getMissingReleaseMRAlert(relSt.ticketId, relSt.mrs);
            if (alert) section.appendChild(alert);
            renderMRItems(subSection, relSt.mrs);
          } else {
            const empty = document.createElement('div');
            empty.className = 'no-mrs';
            empty.textContent = 'No merge requests found';
            subSection.appendChild(empty);
          }
          section.appendChild(subSection);
        });
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
  document.getElementById('fix-mrs-btn').style.display = '';

  chrome.runtime.sendMessage({ action: 'getSyncState' }).then(state => {
    if (state && state.running) {
      setStatus(`Sync in progress... ${state.completed}/${state.total}`, 'info');
      syncBtn.disabled = true;
      syncBtn.textContent = `Syncing ${state.completed}/${state.total}...`;
      renderProgress(state.progress);
      startPolling();
      return;
    }

    if (state && state.results && state.results.length > 0 && state.progress && state.progress.length > 0) {
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
      if (!state || !state.results || !state.results.length) {
        setStatus('No merge requests found on this page.', 'info');
      }
      syncBtn.disabled = true;
    }
  }).catch(() => {
    setStatus('Loading...', 'info');
  });
}

async function initJira(ticketId) {
  showJiraView();
  jiraTicketEl.textContent = ticketId;
  setStatus(`Viewing Jira ticket: ${ticketId}`, 'info');

  const settings = await chrome.storage.sync.get({ autoLookup: true });
  if (!settings.autoLookup) return;

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
}

function renderEpicResults(data) {
  jiraResultsEl.innerHTML = '';

  if (data.error) {
    setStatus(data.error, 'error');
    return;
  }

  const issues = data.issues || [];
  const totalMRs = issues.reduce((sum, i) => sum + i.mrs.length, 0);

  if (totalMRs === 0) {
    setStatus(`No merge requests found for this epic (${issues.length} issue(s) checked)`, 'info');
    return;
  }

  setStatus(`Found ${totalMRs} MR(s) across ${issues.length} issue(s)`, 'success');

  issues.forEach(issue => {
    if (issue.mrs.length === 0) return;
    const section = document.createElement('div');
    section.className = 'lookup-section';
    section.innerHTML = `<div class="lookup-section-header">#${issue.issueIid} <span class="subtask-summary">${issue.issueTitle}</span> <span class="subtask-status">${issue.issueState}</span></div>`;
    renderMRItems(section, issue.mrs);
    jiraResultsEl.appendChild(section);
  });
}

async function initEpic(context) {
  showJiraView();
  jiraTicketEl.textContent = `Epic #${context.epicIid}`;
  setStatus(`Epic #${context.epicIid}`, 'info');

  lookupBtn.disabled = true;
  lookupBtn.textContent = 'Searching...';
  setStatus(`Fetching MRs for epic #${context.epicIid}...`, 'info');

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'lookupEpicMRs',
      groupPath: context.groupPath,
      epicIid: context.epicIid
    });
    renderEpicResults(result);
  } catch (e) {
    setStatus(`Lookup failed: ${e.message}`, 'error');
  }

  lookupBtn.disabled = false;
  lookupBtn.textContent = 'Lookup Merge Requests';
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

async function init() {
  showGitlabView();
  syncBtn.disabled = true;

  // Non-blocking context fetch
  chrome.runtime.sendMessage({ action: 'getPageContext' }).then(context => {
    if (!context || context.type === 'unknown') {
      chrome.runtime.sendMessage({ action: 'getSyncState' }).then(state => {
        if (state && state.results && state.results.length > 0 && state.progress && state.progress.length > 0) {
          const successCount = state.results.filter(r => r.status === 'success').length;
          setStatus(`Last sync: ${successCount}/${state.results.length} succeeded.`, 'success');
          renderProgress(state.progress);
          renderResults(state.results);
        } else {
          setStatus('Navigate to a GitLab MR page or Jira ticket to use this extension.', 'info');
        }
      }).catch(() => {
        setStatus('Navigate to a GitLab MR page or Jira ticket to use this extension.', 'info');
      });
      return;
    }

    if (context.type === 'jira') {
      initJira(context.ticketId);
    } else if (context.type === 'epic') {
      initEpic(context);
    } else if (context.type === 'gitlab') {
      initGitlab(context);
    }
  }).catch(() => {
    setStatus('Could not read page. Try refreshing.', 'error');
  });
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
    const context = await chrome.runtime.sendMessage({ action: 'getPageContext' });
    if (context.type === 'epic') {
      const result = await chrome.runtime.sendMessage({
        action: 'lookupEpicMRs',
        groupPath: context.groupPath,
        epicIid: context.epicIid
      });
      renderEpicResults(result);
    } else {
      const result = await chrome.runtime.sendMessage({ action: 'lookupMRs', ticketId });
      renderJiraResults(result);
    }
  } catch (e) {
    setStatus(`Lookup failed: ${e.message}`, 'error');
  }

  lookupBtn.disabled = false;
  lookupBtn.textContent = 'Lookup Merge Requests';
});

optionsLink.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function createMRToTarget(targetBranch, titleFn) {
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
    const title = titleFn ? titleFn(defaultBranch) : '';
    const titleParam = title ? `&merge_request[title]=${encodeURIComponent(title)}` : '';
    const mrUrl = `https://${host}/${projectPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(defaultBranch)}&merge_request[target_branch]=${encodeURIComponent(targetBranch)}${titleParam}`;
    chrome.tabs.create({ url: mrUrl, active: true });
  } catch (e) {
    setStatus(`Failed to create MR link: ${e.message}`, 'error');
  }
}

document.getElementById('create-mr-testing-btn').addEventListener('click', () => {
  createMRToTarget('testing', branch => `Sync release ${branch.replace(/^releases\//, '')}`);
});

document.getElementById('create-mr-main-btn').addEventListener('click', () => {
  createMRToTarget('main', branch => `Release ${branch.replace(/^releases\//, '')}`);
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

document.getElementById('create-mr-main-to-testing-btn').addEventListener('click', async () => {
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

document.getElementById('create-mr-main-to-release-btn').addEventListener('click', async () => {
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

  const { gitlabToken } = await chrome.storage.sync.get(['gitlabToken']);
  const projectId = encodeURIComponent(projectPath);
  const res = await fetch(`https://${host}/api/v4/projects/${projectId}`, {
    headers: { 'PRIVATE-TOKEN': gitlabToken }
  });
  const project = await res.json();
  const defaultBranch = project.default_branch || 'main';

  const mrUrl = `https://${host}/${projectPath}/-/merge_requests/new?merge_request[source_branch]=main&merge_request[target_branch]=${encodeURIComponent(defaultBranch)}&merge_request[title]=${encodeURIComponent('Sync main to release')}`;
  chrome.tabs.create({ url: mrUrl, active: true });
});

init();
