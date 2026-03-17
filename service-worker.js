// Exposed — Service Worker
// Observes web requests and maintains per-tab data exposure state

let trackerDomains = new Set();
const tabState = new Map(); // tabId → { url, domain, exposures: Map<category, Set<evidence>> }
const sessionHistory = new Map(); // domain → { url, domain, exposures: Map<category, Set<evidence>> }

let persistTimer = null;
let sessionPersistTimer = null;
let badgeTimer = null;

const CATEGORIES = {
  EMAIL: "Email",
  LOCATION: "Location",
  FINGERPRINT: "Device ID",
  IP_ADDRESS: "IP Address",
  BROWSING_HISTORY: "Browsing History",
  COOKIES: "Cross-Site Tracking",
  NAME: "Name",
  SEARCH_TERMS: "Search Terms",
};

// eTLD+1 extraction (simple: takes last two segments, or last three if second-to-last is short like co.uk)
function getRootDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const sld = parts[parts.length - 2];
  if (
    sld.length <= 3 &&
    ["co", "com", "org", "net", "gov", "edu", "ac"].includes(sld)
  ) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

function isThirdParty(requestDomain, tabDomain) {
  return getRootDomain(requestDomain) !== getRootDomain(tabDomain);
}

function isTrackerDomain(hostname) {
  const root = getRootDomain(hostname);
  // Check root domain first, then full hostname for subdomain-specific entries
  // (e.g. "analytics.twitter.com" is a tracker but "twitter.com" is not)
  return trackerDomains.has(root) || trackerDomains.has(hostname);
}

function getOrCreateTab(tabId, tabUrl) {
  if (!tabState.has(tabId)) {
    let domain = "";
    try {
      domain = new URL(tabUrl).hostname;
    } catch (e) {}
    tabState.set(tabId, { url: tabUrl, domain, exposures: new Map() });
  }
  return tabState.get(tabId);
}

function addExposure(tabId, category, evidence) {
  const tab = tabState.get(tabId);
  if (!tab) return;
  if (!tab.exposures.has(category)) {
    tab.exposures.set(category, new Set());
  }
  const evidenceSet = tab.exposures.get(category);
  evidenceSet.add(evidence);

  // Also record in session history (keyed by domain, never deleted)
  if (tab.domain) {
    if (!sessionHistory.has(tab.domain)) {
      sessionHistory.set(tab.domain, { url: tab.url, domain: tab.domain, exposures: new Map() });
    }
    const session = sessionHistory.get(tab.domain);
    if (!session.exposures.has(category)) {
      session.exposures.set(category, new Set());
    }
    const sessionEvidence = session.exposures.get(category);
    sessionEvidence.add(evidence);
    debouncedSessionPersist();
  }

  debouncedBadge();
  debouncedPersist();
}

// --- Email detection ---
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+%40[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const EMAIL_PARAMS = [
  "email",
  "mail",
  "e-mail",
  "user_email",
  "login",
  "username",
];

function checkEmailInUrl(url, tabId, requestDomain) {
  try {
    const u = new URL(url);
    const search = u.search + u.hash;
    if (EMAIL_REGEX.test(search)) {
      addExposure(
        tabId,
        CATEGORIES.EMAIL,
        `your email sent to ${getRootDomain(requestDomain)}`
      );
      return;
    }
    for (const [key, val] of u.searchParams) {
      if (EMAIL_PARAMS.includes(key.toLowerCase()) && val.includes("@")) {
        addExposure(
          tabId,
          CATEGORIES.EMAIL,
          `your email sent to ${getRootDomain(requestDomain)}`
        );
        return;
      }
      if (val.match(/^[^@]+@[^@]+\.[a-z]{2,}$/i)) {
        addExposure(
          tabId,
          CATEGORIES.EMAIL,
          `your email sent to ${getRootDomain(requestDomain)}`
        );
        return;
      }
    }
  } catch (e) {}
}

// --- Name detection ---
const NAME_PARAMS = [
  "fname",
  "firstname",
  "first_name",
  "lname",
  "lastname",
  "last_name",
  "name",
  "full_name",
  "fullname",
  "user_name",
  "display_name",
  "realname",
];

function checkNameInUrl(url, tabId, requestDomain) {
  try {
    const u = new URL(url);
    for (const [key, val] of u.searchParams) {
      if (NAME_PARAMS.includes(key.toLowerCase()) && val.length > 1) {
        addExposure(
          tabId,
          CATEGORIES.NAME,
          `your name sent to ${getRootDomain(requestDomain)}`
        );
        return;
      }
    }
  } catch (e) {}
}

// --- Search terms detection ---
const SEARCH_PARAMS = [
  "q",
  "query",
  "search",
  "searchquery",
  "search_query",
  "keyword",
  "keywords",
  "term",
  "terms",
];

// Filters out IDs, hashes, base64, and other non-human-readable values
function looksLikeSearchTerm(val) {
  if (val.length < 2) return false;
  // Skip if it looks like a hash/token/ID (no spaces, mostly alphanumeric + special chars)
  if (/^[a-zA-Z0-9_\-=+\/]{16,}$/.test(val)) return false;
  // Must contain at least one letter
  if (!/[a-zA-Z]/.test(val)) return false;
  return true;
}

function checkSearchTerms(url, tabId, requestDomain) {
  try {
    const u = new URL(url);
    for (const [key, val] of u.searchParams) {
      if (SEARCH_PARAMS.includes(key.toLowerCase()) && looksLikeSearchTerm(val)) {
        addExposure(
          tabId,
          CATEGORIES.SEARCH_TERMS,
          `your search "${val.slice(0, 30)}" sent to ${getRootDomain(requestDomain)}`
        );
        return;
      }
    }
  } catch (e) {}
}

// --- IP geolocation endpoint detection ---
const IP_GEO_DOMAINS = [
  "ipinfo.io",
  "ipapi.co",
  "ip-api.com",
  "ipgeolocation.io",
  "ipstack.com",
  "freegeoip.net",
  "geoip-db.com",
  "geolocation-db.com",
  "extreme-ip-lookup.com",
  "ipdata.co",
  "ipify.org",
  "ipwhois.io",
  "abstractapi.com",
  "maxmind.com",
];

function checkIPGeolocation(requestDomain) {
  const root = getRootDomain(requestDomain);
  return IP_GEO_DOMAINS.some(
    (d) => root === d || requestDomain.endsWith("." + d)
  );
}

// --- Load tracker domains ---
async function loadTrackers() {
  try {
    const resp = await fetch(chrome.runtime.getURL("tracker-domains.json"));
    const list = await resp.json();
    trackerDomains = new Set(list);
  } catch (e) {
    console.error("Exposed: failed to load tracker domains", e);
  }
}

// --- Badge ---
// Always shows the ACTIVE tab's category count, not the triggering tab's
function updateBadge() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (chrome.runtime.lastError || !tabs || !tabs[0]) return;
    const tab = tabState.get(tabs[0].id);
    const count = tab ? tab.exposures.size : 0;
    chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  });
}

function debouncedBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(updateBadge, 500);
}

// --- Persistence ---
function debouncedPersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistState, 1000);
}

function persistState() {
  const serialized = {};
  for (const [tabId, tab] of tabState) {
    const exposures = {};
    for (const [cat, evidenceSet] of tab.exposures) {
      exposures[cat] = [...evidenceSet];
    }
    serialized[tabId] = { url: tab.url, domain: tab.domain, exposures };
  }
  chrome.storage.local.set({ tabState: serialized });
}

function debouncedSessionPersist() {
  clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(persistSessionHistory, 1000);
}

function persistSessionHistory() {
  const serialized = {};
  for (const [domain, entry] of sessionHistory) {
    const exposures = {};
    for (const [cat, evidenceSet] of entry.exposures) {
      exposures[cat] = [...evidenceSet];
    }
    serialized[domain] = { url: entry.url, domain: entry.domain, exposures };
  }
  chrome.storage.session.set({ sessionHistory: serialized });
}

async function restoreSessionHistory() {
  try {
    const result = await chrome.storage.session.get("sessionHistory");
    if (result.sessionHistory) {
      for (const [domain, entry] of Object.entries(result.sessionHistory)) {
        const exposures = new Map();
        for (const [cat, evidenceArr] of Object.entries(entry.exposures)) {
          exposures.set(cat, new Set(evidenceArr));
        }
        sessionHistory.set(domain, { url: entry.url, domain: entry.domain, exposures });
      }
    }
  } catch (e) {}
}

async function restoreState() {
  try {
    const result = await chrome.storage.local.get("tabState");
    if (result.tabState) {
      for (const [tabId, tab] of Object.entries(result.tabState)) {
        const exposures = new Map();
        for (const [cat, evidenceArr] of Object.entries(tab.exposures)) {
          exposures.set(cat, new Set(evidenceArr));
        }
        tabState.set(Number(tabId), {
          url: tab.url,
          domain: tab.domain,
          exposures,
        });
      }
    }
  } catch (e) {}
  updateBadge();
}

// --- webRequest listeners ---

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;

    let requestDomain;
    try {
      requestDomain = new URL(details.url).hostname;
    } catch (e) {
      return;
    }

    // Get tab info
    const tab = tabState.get(details.tabId);
    if (!tab || !tab.domain) return;

    const thirdParty = isThirdParty(requestDomain, tab.domain);
    if (!thirdParty) return;

    // IP Address: any request to known tracker
    if (isTrackerDomain(requestDomain)) {
      addExposure(
        details.tabId,
        CATEGORIES.IP_ADDRESS,
        `your IP shared with ${getRootDomain(requestDomain)}`
      );
    }

    // Location via IP geo endpoints
    if (checkIPGeolocation(requestDomain)) {
      addExposure(
        details.tabId,
        CATEGORIES.LOCATION,
        `your location looked up via ${getRootDomain(requestDomain)}`
      );
    }

    // Email in URL
    checkEmailInUrl(details.url, details.tabId, requestDomain);

    // Name in URL
    checkNameInUrl(details.url, details.tabId, requestDomain);

    // Search terms in URL
    checkSearchTerms(details.url, details.tabId, requestDomain);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;

    let requestDomain;
    try {
      requestDomain = new URL(details.url).hostname;
    } catch (e) {
      return;
    }

    const tab = tabState.get(details.tabId);
    if (!tab || !tab.domain) return;

    const thirdParty = isThirdParty(requestDomain, tab.domain);
    if (!thirdParty) return;

    if (!details.requestHeaders) return;

    for (const header of details.requestHeaders) {
      const name = header.name.toLowerCase();

      // Cookies sent to third parties
      if (name === "cookie" && header.value) {
        addExposure(
          details.tabId,
          CATEGORIES.COOKIES,
          `tracking cookie sent to ${getRootDomain(requestDomain)}`
        );
      }

      // Referer to third parties = browsing history leak
      if (name === "referer" && header.value) {
        addExposure(
          details.tabId,
          CATEGORIES.BROWSING_HISTORY,
          `this page shared with ${getRootDomain(requestDomain)}`
        );
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

// --- Tab lifecycle ---

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Only reset state on actual navigation (URL change), not just loading status
  if (changeInfo.url) {
    const url = changeInfo.url;
    if (url.startsWith("chrome://") || url.startsWith("about:") || url.startsWith("chrome-extension://")) {
      tabState.delete(tabId);
    } else {
      let domain = "";
      try {
        domain = new URL(url).hostname;
      } catch (e) {}
      tabState.set(tabId, { url, domain, exposures: new Map() });
    }
    updateBadge();
    persistState();
  } else if (changeInfo.status === "loading" && !tabState.has(tabId)) {
    // First time seeing this tab (e.g. after service worker restart)
    const url = tab.url || "";
    if (url && !url.startsWith("chrome://") && !url.startsWith("about:")) {
      let domain = "";
      try { domain = new URL(url).hostname; } catch (e) {}
      tabState.set(tabId, { url, domain, exposures: new Map() });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
  updateBadge();
  persistState();
});

// Update badge when user switches tabs
chrome.tabs.onActivated.addListener(() => {
  updateBadge();
});

// --- Messages from content scripts + popup API ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Popup requesting state
  if (msg.type === "get-state") {
    const result = {};
    for (const [tabId, tab] of tabState) {
      const exposures = {};
      for (const [cat, evidenceSet] of tab.exposures) {
        exposures[cat] = [...evidenceSet];
      }
      result[tabId] = { url: tab.url, domain: tab.domain, exposures };
    }
    sendResponse(result);
    return true;
  }

  // Popup requesting session history
  if (msg.type === "get-session-state") {
    const result = {};
    for (const [domain, entry] of sessionHistory) {
      const exposures = {};
      for (const [cat, evidenceSet] of entry.exposures) {
        exposures[cat] = [...evidenceSet];
      }
      result[domain] = { url: entry.url, domain: entry.domain, exposures };
    }
    sendResponse(result);
    return true;
  }

  // Content script detections
  if (!sender.tab) return;
  const tabId = sender.tab.id;

  if (!tabState.has(tabId) && sender.tab.url) {
    getOrCreateTab(tabId, sender.tab.url);
  }

  if (msg.type === "fingerprint-detected") {
    const evidence = typeof msg.evidence === "string" ? msg.evidence.slice(0, 200) : "fingerprinting API used";
    addExposure(tabId, CATEGORIES.FINGERPRINT, evidence);
  }
  // Audio fingerprint: only flag if the page has tracker scripts (legitimate
  // audio/video platforms like LiveKit, Zoom, etc. also use OfflineAudioContext)
  if (msg.type === "audio-fingerprint-maybe") {
    const tab = tabState.get(tabId);
    if (tab && tab.exposures.has(CATEGORIES.IP_ADDRESS)) {
      const evidence = typeof msg.evidence === "string" ? msg.evidence.slice(0, 200) : "your device identified via audio";
      addExposure(tabId, CATEGORIES.FINGERPRINT, evidence);
    }
  }
  if (msg.type === "geolocation-detected") {
    const evidence = typeof msg.evidence === "string" ? msg.evidence.slice(0, 200) : "GPS location requested";
    addExposure(tabId, CATEGORIES.LOCATION, evidence);
  }
});

// --- Init ---

async function init() {
  // Load trackers in parallel with state restoration for faster startup
  const [,] = await Promise.all([
    loadTrackers(),
    restoreState(),
    restoreSessionHistory(),
  ]);

  // Reconcile restored state with actual open tabs
  const tabs = await chrome.tabs.query({});
  const liveTabIds = new Set(tabs.map((t) => t.id));

  // Remove stale tab IDs that no longer exist
  for (const tabId of tabState.keys()) {
    if (!liveTabIds.has(tabId)) {
      tabState.delete(tabId);
    }
  }

  // Add any open tabs not yet tracked
  for (const tab of tabs) {
    if (tab.id && tab.url && !tabState.has(tab.id)) {
      if (!tab.url.startsWith("chrome://") && !tab.url.startsWith("about:")) {
        getOrCreateTab(tab.id, tab.url);
      }
    }
  }

  // Seed session history from existing tab state so "This session" isn't empty
  for (const [, tab] of tabState) {
    if (!tab.domain || tab.exposures.size === 0) continue;
    if (!sessionHistory.has(tab.domain)) {
      sessionHistory.set(tab.domain, { url: tab.url, domain: tab.domain, exposures: new Map() });
    }
    const session = sessionHistory.get(tab.domain);
    for (const [cat, evidenceSet] of tab.exposures) {
      if (!session.exposures.has(cat)) {
        session.exposures.set(cat, new Set());
      }
      const sessionEvidence = session.exposures.get(cat);
      for (const e of evidenceSet) {
        sessionEvidence.add(e);
      }
    }
  }

  updateBadge();
  persistState();
  persistSessionHistory();
}

init();
