// DevTools Showcase: the devtools page (hidden; runs once per DevTools window).
//
// Creates two panels, wires ExtensionPanel.onShown/onHidden, and answers
// "ping" messages so the panel can prove panel <-> devtools page messaging.
// Everything is feature-detected: on a host where onShown/onHidden are inert this
// still loads, and the panel reports the gap instead of a crash.
const msg = (key, fallback) => {
  try {
    return (chrome.i18n && chrome.i18n.getMessage(key)) || fallback;
  } catch {
    return fallback;
  }
};

const toBackground = (type, extra) => {
  try {
    chrome.runtime.sendMessage({ to: "background", from: "devtools-page", type, ...extra }, () => {
      void chrome.runtime.lastError; // no background yet is not an error worth a throw
    });
  } catch {
    /* no runtime messaging on this host */
  }
};

const STATE_KEY = "showcase:visibility";

/** Run `fn` against storage.local when this host has it. */
const localStore = (fn) => {
  if (chrome.storage && chrome.storage.local) fn(chrome.storage.local);
};

// This page is the single writer and lives as long as the DevTools window, so the
// counters are kept in memory and mirrored to storage (a read-modify-write against
// storage would race when hidden and shown fire a few ms apart).
const visibility = {};
localStore((area) => area.remove(STATE_KEY)); // counters are per DevTools window, not per install

/** Persist + announce a visibility transition (the panel may not be loaded yet). */
const record = (panelName, kind, win) => {
  const s = visibility[panelName] || (visibility[panelName] = { shown: 0, hidden: 0 });
  s[kind] += 1;
  s.last = kind;
  s.lastAt = Date.now();
  if (kind === "shown") s.gotWindow = !!win && typeof win === "object";
  localStore((area) => area.set({ [STATE_KEY]: JSON.parse(JSON.stringify(visibility)) }));
  try {
    chrome.runtime.sendMessage({ to: "panel", type: "visibility", panelName, kind, state: { ...s } }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* panel not open */
  }
  toBackground("log", { text: `panel "${panelName}" ${kind}` });
};

const wire = (name, panel) => {
  // What this host exposes, so the panel can say "unsupported here" truthfully
  // instead of inferring it from silence.
  const support = {
    onShown: !!(panel && panel.onShown && typeof panel.onShown.addListener === "function"),
    onHidden: !!(panel && panel.onHidden && typeof panel.onHidden.addListener === "function"),
  };
  localStore((area) => area.set({ ["showcase:support:" + name]: support }));
  if (!panel) return;
  if (panel.onShown && typeof panel.onShown.addListener === "function") {
    panel.onShown.addListener((win) => record(name, "shown", win));
  }
  if (panel.onHidden && typeof panel.onHidden.addListener === "function") {
    panel.onHidden.addListener(() => record(name, "hidden"));
  }
};

const panelsApi = chrome.devtools && chrome.devtools.panels;
if (panelsApi && typeof panelsApi.create === "function") {
  panelsApi.create(msg("panelTitle", "Showcase"), "icon.png", "panel.html", (panel) => wire("main", panel));
  panelsApi.create(msg("logPanelTitle", "Showcase Log"), "icon.png", "log.html", (panel) => wire("log", panel));
} else {
  toBackground("log", { text: "chrome.devtools.panels.create is not available on this host" });
}

// Cross-frame storage.onChanged: counted here, reported on request.
const xf = { local: 0, session: 0, last: null };
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (changes["showcase:xframe"]) {
      xf[area] = (xf[area] || 0) + 1;
      xf.last = changes["showcase:xframe"].newValue;
      localStore((store) => store.set({ "showcase:xframe-seen:devtools": { ...xf } }));
    }
  });
}

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || m.to !== "devtools") return undefined;
    if (m.type === "xframe-report") {
      sendResponse({ ...xf });
    } else if (m.type === "ping") {
      sendResponse({
        type: "pong",
        from: "devtools-page",
        tabId: chrome.devtools.inspectedWindow && chrome.devtools.inspectedWindow.tabId,
        themeName: panelsApi && panelsApi.themeName,
      });
    }
    return undefined;
  });
}

toBackground("log", { text: "devtools page loaded" });
