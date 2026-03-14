// Exposed — Popup Script

const CATEGORY_META = {
  Email:                { color: "#ef4444", order: 0 },
  Name:                 { color: "#ef4444", order: 1 },
  "Device ID":          { color: "#f97316", order: 2 },
  Location:             { color: "#f97316", order: 3 },
  "Search Terms":       { color: "#f97316", order: 4 },
  "IP Address":         { color: "#eab308", order: 5 },
  "Browsing History":   { color: "#eab308", order: 6 },
  "Cross-Site Tracking": { color: "#eab308", order: 7 },
};

let currentView = "categories";
let currentCategory = null;
let currentScope = "tab";
let currentTabId = null;
let currentTabDomain = "";
let isRestrictedPage = false;
let fullState = {};
let sessionState = {};
let lastRenderedHash = "";

// --- Helpers ---

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function getDomainFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return url || "";
  }
}

function getFilteredState() {
  if (currentScope === "session") {
    return sessionState;
  }
  if (currentScope === "tab" && currentTabId != null) {
    const tabData = fullState[currentTabId];
    if (tabData) return { [currentTabId]: tabData };
    return {};
  }
  return fullState;
}

function aggregateState(state) {
  const cats = {};
  for (const [tabId, tab] of Object.entries(state)) {
    if (!tab.exposures) continue;
    for (const [category, evidenceArr] of Object.entries(tab.exposures)) {
      if (!cats[category]) cats[category] = [];
      cats[category].push({
        tabId: Number(tabId),
        domain: getDomainFromUrl(tab.url),
        url: tab.url,
        evidence: Array.isArray(evidenceArr) ? evidenceArr : [],
      });
    }
  }
  return cats;
}

// --- Render ---

function render() {
  const state = getFilteredState();
  const aggregated = aggregateState(state);

  // Skip DOM rebuild if nothing changed
  const hash = JSON.stringify(aggregated) + "|" + currentView + "|" + currentCategory + "|" + currentScope;
  if (hash === lastRenderedHash) return;
  lastRenderedHash = hash;

  if (currentView === "detail" && currentCategory) {
    if (aggregated[currentCategory]) {
      renderDetail(aggregated, currentCategory);
    } else {
      currentView = "categories";
      currentCategory = null;
      renderCategories(aggregated);
    }
  } else {
    renderCategories(aggregated);
  }
}

function renderCategories(aggregated) {
  const listEl = document.getElementById("category-list");
  const emptyEl = document.getElementById("empty-state");
  const detailEl = document.getElementById("detail-view");
  const backBtn = document.getElementById("back-btn");
  const scopeToggle = document.getElementById("scope-toggle");

  detailEl.classList.add("hidden");
  backBtn.classList.add("hidden");
  scopeToggle.classList.remove("hidden");

  updateSubtitle(aggregated);

  const sortedCats = Object.keys(aggregated).sort(
    (a, b) => (CATEGORY_META[a]?.order ?? 99) - (CATEGORY_META[b]?.order ?? 99)
  );

  if (sortedCats.length === 0) {
    listEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
    const emptyIcon = document.querySelector(".empty-icon");
    const emptyTitle = document.querySelector(".empty-title");
    const emptyDesc = document.querySelector(".empty-desc");
    if (currentScope === "tab" && isRestrictedPage) {
      emptyIcon.textContent = "\u2014";
      emptyIcon.style.color = "#72757e";
      emptyIcon.style.background = "rgba(114,117,126,0.1)";
      emptyTitle.textContent = "Can't scan this page";
      emptyDesc.textContent = "Extensions don't have access to browser internal pages.";
    } else if (currentScope === "tab") {
      emptyIcon.textContent = "\u2713";
      emptyIcon.style.color = "#2cb67d";
      emptyIcon.style.background = "rgba(44,182,125,0.1)";
      emptyTitle.textContent = "Looking clean";
      emptyDesc.textContent = "No data sharing detected on this page.";
    } else if (currentScope === "all") {
      emptyIcon.textContent = "\u2713";
      emptyIcon.style.color = "#2cb67d";
      emptyIcon.style.background = "rgba(44,182,125,0.1)";
      emptyTitle.textContent = "All clear";
      emptyDesc.textContent = "No data sharing detected across your open tabs.";
    } else {
      emptyIcon.textContent = "\u2713";
      emptyIcon.style.color = "#2cb67d";
      emptyIcon.style.background = "rgba(44,182,125,0.1)";
      emptyTitle.textContent = "All clear";
      emptyDesc.textContent = "No data sharing detected this session.";
    }
    return;
  }

  emptyEl.classList.add("hidden");
  listEl.classList.remove("hidden");

  listEl.innerHTML = sortedCats
    .map((cat) => {
      const meta = CATEGORY_META[cat] || { color: "#888", order: 99 };
      const safeCat = escapeHtml(cat);
      // Always show total evidence count (third parties) for consistency
      const count = aggregated[cat].reduce((sum, t) => sum + t.evidence.length, 0);
      return `
      <div class="category-item" data-category="${safeCat}">
        <div class="category-left">
          <span class="category-dot" style="background:${meta.color}"></span>
          <span class="category-name">${safeCat}</span>
        </div>
        <span class="category-count">${count}</span>
      </div>`;
    })
    .join("");

  listEl.querySelectorAll(".category-item").forEach((el) => {
    el.addEventListener("click", () => {
      currentView = "detail";
      currentCategory = el.dataset.category;
      lastRenderedHash = ""; // Force re-render
      render();
    });
  });
}

function renderDetail(aggregated, category) {
  const listEl = document.getElementById("category-list");
  const detailEl = document.getElementById("detail-view");
  const backBtn = document.getElementById("back-btn");
  const subtitle = document.getElementById("subtitle");
  const scopeToggle = document.getElementById("scope-toggle");

  listEl.classList.add("hidden");
  detailEl.classList.remove("hidden");
  backBtn.classList.remove("hidden");
  scopeToggle.classList.add("hidden");

  const meta = CATEGORY_META[category] || { color: "#888" };
  const tabs = aggregated[category] || [];

  const totalEvidence = tabs.reduce((sum, t) => sum + t.evidence.length, 0);
  if (currentScope === "tab") {
    subtitle.textContent = `${totalEvidence} third part${totalEvidence === 1 ? "y" : "ies"}`;
  } else if (currentScope === "session") {
    const domains = new Set(tabs.map((t) => t.domain));
    subtitle.textContent = `${domains.size} site${domains.size === 1 ? "" : "s"}`;
  } else {
    subtitle.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"}`;
  }

  let html = `
    <div class="detail-header">
      <h2><span class="category-dot" style="background:${meta.color}"></span> ${escapeHtml(category)}</h2>
      <div class="detail-count">${detailDescription(tabs)}</div>
    </div>`;

  // Group by domain
  const byDomain = new Map();
  for (const tab of tabs) {
    if (!byDomain.has(tab.domain)) {
      byDomain.set(tab.domain, { ...tab, evidence: [...tab.evidence] });
    } else {
      const existing = byDomain.get(tab.domain);
      for (const e of tab.evidence) {
        if (!existing.evidence.includes(e)) existing.evidence.push(e);
      }
    }
  }

  for (const [, tab] of byDomain) {
    const hiddenItems = tab.evidence.slice(5);
    html += `
      <div class="tab-entry">
        <div class="tab-domain">${escapeHtml(tab.domain)}</div>
        <div class="tab-evidence">
          ${tab.evidence
            .slice(0, 5)
            .map((e) => `<div class="tab-evidence-item">${escapeHtml(e)}</div>`)
            .join("")}
          ${hiddenItems.length > 0 ? `
            <div class="tab-evidence-overflow hidden">
              ${hiddenItems.map((e) => `<div class="tab-evidence-item">${escapeHtml(e)}</div>`).join("")}
            </div>
            <div class="tab-evidence-toggle" data-count="${hiddenItems.length}">+ ${hiddenItems.length} more</div>
          ` : ""}
        </div>
      </div>`;
  }

  detailEl.innerHTML = html;

  // Wire up expand/collapse toggles
  detailEl.querySelectorAll(".tab-evidence-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const overflow = toggle.previousElementSibling;
      const isHidden = overflow.classList.contains("hidden");
      overflow.classList.toggle("hidden");
      toggle.textContent = isHidden ? "show less" : `+ ${toggle.dataset.count} more`;
    });
  });
}

function detailDescription(tabs) {
  if (currentScope === "tab") {
    const n = tabs.reduce((sum, t) => sum + t.evidence.length, 0);
    return `Shared with ${n} third part${n === 1 ? "y" : "ies"} on this page`;
  }
  if (currentScope === "session") {
    const domains = new Set(tabs.map((t) => t.domain));
    return `${domains.size} site${domains.size === 1 ? "" : "s"} exposed this data this session`;
  }
  return `${tabs.length} tab${tabs.length === 1 ? "" : "s"} exposing this data`;
}

function updateSubtitle(aggregated) {
  const subtitle = document.getElementById("subtitle");
  const catCount = Object.keys(aggregated).length;

  if (currentScope === "tab") {
    if (isRestrictedPage) {
      subtitle.textContent = "";
    } else if (catCount === 0) {
      subtitle.textContent = currentTabDomain || "";
    } else {
      const prefix = currentTabDomain ? currentTabDomain + " \u2014 " : "";
      subtitle.textContent = `${prefix}sharing ${catCount} data type${catCount === 1 ? "" : "s"}`;
    }
  } else if (currentScope === "session") {
    if (catCount === 0) {
      subtitle.textContent = "No exposures this session";
    } else {
      const domains = new Set();
      for (const entries of Object.values(aggregated)) {
        for (const t of entries) domains.add(t.domain);
      }
      subtitle.textContent = `${catCount} type${catCount === 1 ? "" : "s"} across ${domains.size} site${domains.size === 1 ? "" : "s"}`;
    }
  } else {
    if (catCount === 0) {
      subtitle.textContent = "No exposures detected";
    } else {
      const tabIds = new Set();
      for (const entries of Object.values(aggregated)) {
        for (const t of entries) tabIds.add(t.tabId);
      }
      subtitle.textContent = `${catCount} type${catCount === 1 ? "" : "s"} across ${tabIds.size} tab${tabIds.size === 1 ? "" : "s"}`;
    }
  }
}

// --- Data fetching ---

function refresh() {
  chrome.runtime.sendMessage({ type: "get-state" }, (state) => {
    if (chrome.runtime.lastError || !state) {
      state = {};
    }
    fullState = state;
    render();
  });
  chrome.runtime.sendMessage({ type: "get-session-state" }, (state) => {
    if (chrome.runtime.lastError || !state) {
      state = {};
    }
    sessionState = state;
    if (currentScope === "session") render();
  });
}

// --- Event listeners ---

document.querySelectorAll(".scope-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const newScope = btn.dataset.scope;
    if (newScope === currentScope) return;
    currentScope = newScope;
    currentView = "categories";
    currentCategory = null;
    lastRenderedHash = "";
    document.querySelectorAll(".scope-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    render();
  });
});

document.getElementById("back-btn").addEventListener("click", () => {
  currentView = "categories";
  currentCategory = null;
  lastRenderedHash = "";
  render();
});

// --- Init ---

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    currentTabId = tabs[0].id;
    const url = tabs[0].url || "";
    currentTabDomain = getDomainFromUrl(url);
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      isRestrictedPage = true;
    }
  }

  // Load cached state instantly, then poll live
  chrome.storage.local.get("tabState", (result) => {
    if (result.tabState) {
      fullState = result.tabState;
      render();
    }
  });
  chrome.storage.session.get("sessionHistory", (result) => {
    if (result.sessionHistory) {
      sessionState = result.sessionHistory;
      if (currentScope === "session") render();
    }
  });
  refresh();
  setInterval(refresh, 2000);
});
