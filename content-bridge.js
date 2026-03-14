// Exposed — Content Script (ISOLATED world)
// Bridges messages from the MAIN world content-detect.js to the service worker

(function () {
  "use strict";

  const CHANNEL = "__exposed_detection__";
  const seen = new Set();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.channel !== CHANNEL) return;

    const { type, evidence } = event.data;

    // Deduplicate per page load
    const key = type + "|" + evidence;
    if (seen.has(key)) return;
    seen.add(key);

    chrome.runtime.sendMessage({ type, evidence });
  });
})();
