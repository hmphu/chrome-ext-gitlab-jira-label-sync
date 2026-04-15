(() => {
  const JIRA_PATTERN = /[A-Z][A-Z0-9]+-\d+/;

  function extractMergeRequests() {
    const mrRows = document.querySelectorAll('.merge-request');
    const results = [];

    mrRows.forEach(row => {
      const titleEl = row.querySelector('.merge-request-title-text a, .js-prefetch-document');
      if (!titleEl) return;

      const title = titleEl.textContent.trim();
      const match = title.match(JIRA_PATTERN);
      if (!match) return;

      const mrLink = titleEl.getAttribute('href');
      const iidMatch = mrLink ? mrLink.match(/merge_requests\/(\d+)/) : null;

      results.push({
        title,
        jiraTicket: match[0],
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

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'extractMRs') {
      const mrs = extractMergeRequests();
      const projectPath = getProjectPath();
      sendResponse({ mrs, projectPath, url: window.location.href });
    }
    return true;
  });
})();
