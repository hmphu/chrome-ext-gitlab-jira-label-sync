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

  function checkParentSync() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkParentStatus', ticketId }, (response) => {
      if (!response || !response.hasParent) return;
      if (response.parentStatus.toUpperCase() !== 'DONE') return;
      if (response.childStatus.toUpperCase() === response.parentStatus.toUpperCase()) return;

      const sync = confirm(
        `Parent ticket ${response.parentKey} status is "${response.parentStatus}".\n` +
        `Current ticket status is "${response.childStatus}".\n\n` +
        `Do you want to sync this ticket's status to "${response.parentStatus}"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionChild',
          ticketId,
          targetStatus: response.parentStatus
        }, (res) => {
          if (res && res.success) {
            location.reload();
          } else {
            alert(`Failed to transition: ${res && res.error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  function checkSubtasksSync() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkSubtasksStatus', ticketId }, (response) => {
      if (!response || response.error) return;
      if (response.currentStatus.toUpperCase() !== 'DONE') return;
      if (!response.pendingSubtasks || response.pendingSubtasks.length === 0) return;

      const list = response.pendingSubtasks.map(s => `  • ${s.key} (${s.status})`).join('\n');
      const sync = confirm(
        `This ticket is "DONE" but ${response.pendingSubtasks.length} subtask(s) are not:\n${list}\n\n` +
        `Do you want to set all subtasks to "DONE"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionSubtasks',
          subtaskKeys: response.pendingSubtasks.map(s => s.key),
          targetStatus: 'Done'
        }, (res) => {
          if (res && res.results) {
            const failed = res.results.filter(r => r.error);
            if (failed.length === 0) {
              location.reload();
            } else {
              alert(`Some transitions failed:\n${failed.map(f => `${f.key}: ${f.error}`).join('\n')}`);
            }
          }
        });
      }
    });
  }

  function checkAllChildrenDone() {
    const ticketId = getJiraTicketId();
    if (!ticketId) return;

    chrome.runtime.sendMessage({ action: 'checkSubtasksStatus', ticketId }, (response) => {
      if (!response || response.error) return;
      if (response.currentStatus.toUpperCase() === 'DONE') return;
      if (!response.totalSubtasks || response.totalSubtasks === 0) return;
      if (response.pendingSubtasks && response.pendingSubtasks.length > 0) return;

      const sync = confirm(
        `All subtasks are "DONE" but this ticket is "${response.currentStatus}".\n\n` +
        `Do you want to set this ticket to "DONE"?`
      );

      if (sync) {
        chrome.runtime.sendMessage({
          action: 'transitionChild',
          ticketId,
          targetStatus: 'Done'
        }, (res) => {
          if (res && res.success) {
            location.reload();
          } else {
            alert(`Failed to transition: ${res && res.error || 'Unknown error'}`);
          }
        });
      }
    });
  }

  autoSend();
  checkParentSync();
  checkSubtasksSync();
  checkAllChildrenDone();
})();
