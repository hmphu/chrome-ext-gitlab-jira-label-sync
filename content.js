(() => {
  const JIRA_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

  function isSingleMRPage() {
    return /\/-\/merge_requests\/\d+/.test(window.location.pathname);
  }

  function extractSingleMR() {
    const iidMatch = window.location.pathname.match(/merge_requests\/(\d+)/);
    if (!iidMatch) return null;

    const titleEl = document.querySelector(
      '.detail-page-header .title, ' +
      '.merge-request-details .title, ' +
      '[data-testid="title-content"], ' +
      '.page-title, ' +
      '.title-container .title, ' +
      '.issue-title-text, ' +
      'h2.gl-font-size-h-display'
    );
    const title = titleEl ? titleEl.textContent.trim() : '';
    const match = title ? title.match(JIRA_PATTERN) : null;

    return {
      title: title || `MR !${iidMatch[1]}`,
      jiraTicket: match ? match[0] : null,
      mrIid: iidMatch[1],
      mrUrl: window.location.pathname,
      needsResolve: !match
    };
  }

  function extractMergeRequests() {
    if (isSingleMRPage()) {
      const mr = extractSingleMR();
      return mr ? [mr] : [];
    }

    const mrRows = document.querySelectorAll('.merge-request');
    const results = [];

    mrRows.forEach(row => {
      const titleEl = row.querySelector('.merge-request-title-text a, .js-prefetch-document');
      if (!titleEl) return;

      const title = titleEl.textContent.trim();
      const match = title.match(JIRA_PATTERN);
      const mrLink = titleEl.getAttribute('href');
      const iidMatch = mrLink ? mrLink.match(/merge_requests\/(\d+)/) : null;

      results.push({
        title,
        jiraTicket: match ? match[0] : null,
        mrIid: iidMatch ? iidMatch[1] : null,
        mrUrl: mrLink
      });
    });

    return results;
  }

  function getProjectPath() {
    const pathMatch = window.location.pathname.match(/^\/(.+?)\/-\/merge_requests/);
    return pathMatch ? pathMatch[1] : null;
  }

  function autoSend() {
    const mrs = extractMergeRequests();
    const projectPath = getProjectPath();
    if (mrs.length > 0 && projectPath) {
      chrome.runtime.sendMessage({ action: 'addMRs', data: { mrs, projectPath } }).catch(() => {});
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMRs') {
      const mrs = extractMergeRequests();
      const projectPath = getProjectPath();
      sendResponse({ mrs, projectPath, url: window.location.href });
    }
    return true;
  });

  autoSend();
})();
