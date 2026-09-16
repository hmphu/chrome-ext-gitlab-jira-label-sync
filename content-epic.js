(() => {
  function getEpicInfo() {
    const path = window.location.pathname;
    const epicMatch = path.match(/^\/groups\/(.+?)\/-\/epics\/(\d+)/);
    if (epicMatch) {
      return { groupPath: epicMatch[1], epicIid: epicMatch[2] };
    }
    return null;
  }

  function autoSend() {
    const info = getEpicInfo();
    if (info) {
      try {
        chrome.storage.session.set({
          pageContext: { type: 'epic', ...info, ts: Date.now() }
        });
      } catch (_) {}
      // No runtime.sendMessage — avoid waking SW on every epic page view
    }
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'getEpicInfo') {
      sendResponse(getEpicInfo());
    }
    return true;
  });

  autoSend();
})();
