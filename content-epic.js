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
      chrome.runtime.sendMessage({ action: 'epicPageDetected', ...info }).catch(() => {});
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
