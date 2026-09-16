/* Zero chrome.* API calls — must paint instantly. Full app loads async. */
(function () {
  // Static shell only. Do not call chrome.tabs / chrome.runtime here —
  // those wake the service worker and can hang the popup for 30s+ when SW is busy.
  var statusEl = document.getElementById('status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.className = 'status info';
    statusEl.textContent = 'Ready';
  }
  window.__popupShell = { painted: true, type: 'pending' };

  function loadFull() {
    var s = document.createElement('script');
    s.src = 'popup.js'; // relative — no getURL, no SW
    s.async = true;
    s.onerror = function () {
      if (statusEl) statusEl.textContent = 'Failed to load popup.js — reload extension';
    };
    document.body.appendChild(s);
  }

  // After browser has painted the popup document
  if (window.requestAnimationFrame) {
    requestAnimationFrame(function () {
      setTimeout(loadFull, 0);
    });
  } else {
    setTimeout(loadFull, 0);
  }
})();
