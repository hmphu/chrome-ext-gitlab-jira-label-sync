(() => {
  function getJiraTicketId() {
    const breadcrumb = document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]');
    if (breadcrumb) return breadcrumb.textContent.trim();

    const match = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
    if (match) return match[1];

    const key = document.querySelector('#key-val, .issue-header-content .key');
    if (key) return key.textContent.trim();

    return null;
  }

  function autoSend() {
    const ticketId = getJiraTicketId();
    if (ticketId) {
      chrome.runtime.sendMessage({ action: 'jiraPageDetected', ticketId }).catch(() => {});
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getJiraTicket') {
      sendResponse({ ticketId: getJiraTicketId() });
    }
    return true;
  });

  autoSend();
})();
