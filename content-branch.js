(() => {
  function getBranchFromUrl() {
    const treeMatch = window.location.pathname.match(/\/-\/tree\/(.+)/);
    if (treeMatch) return decodeURIComponent(treeMatch[1]).split('/')[0];
    return null;
  }

  function getProjectPath() {
    const match = window.location.pathname.match(/^\/(.+?)\/-\//);
    return match ? match[1] : null;
  }

  function getBranchFromElement(el) {
    if (!el) return null;
    const link = el.closest('a');
    if (!link) return null;
    const href = link.getAttribute('href') || '';
    const treeMatch = href.match(/\/-\/tree\/([^/?#]+)/);
    if (treeMatch) return decodeURIComponent(treeMatch[1]);
    const commitMatch = href.match(/\/-\/commits\/([^/?#]+)/);
    if (commitMatch) return decodeURIComponent(commitMatch[1]);
    return null;
  }

  document.addEventListener('contextmenu', (e) => {
    const branchFromEl = getBranchFromElement(e.target);
    const branchFromUrl = getBranchFromUrl();
    const branch = branchFromEl || branchFromUrl;
    const projectPath = getProjectPath();

    chrome.runtime.sendMessage({
      action: 'setBranchContext',
      branch,
      projectPath
    }).catch(() => {});
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getBranchContext') {
      sendResponse({
        branch: getBranchFromUrl(),
        projectPath: getProjectPath()
      });
    }
    return true;
  });
})();
