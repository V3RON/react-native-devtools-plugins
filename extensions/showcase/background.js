// DevTools Showcase: background service worker.
//
// Everything here is feature-detected, so the same file loads in real Chrome (an
// MV3 service worker) and in the RN DevTools shell (an always-on hidden context).
// Module-scope statements run before anything can guard them, so every namespace
// is touched only behind a check.
//
// State shared with the panels lives in chrome.storage.local under "showcase:*"
// keys (a Chrome worker can be evicted, so memory is never the source of truth).
const api = typeof chrome !== "undefined" ? chrome : {};
const KEY = {
  lifecycle: "showcase:lifecycle", // { installReason, installedAt, startups }
  alarms: "showcase:alarms", // { fired, last }
  webreq: "showcase:webreq", // { before, completed, errors, last }
  notif: "showcase:notif", // { created, clicked, closed, lastId }
  download: "showcase:download", // { id, state, filename }
};

// ── tiny callback->promise helper (callback style works on every host) ──────────
const call = (fn, ...args) =>
  new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const err = api.runtime && api.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });

const storeGet = async (key, fallback) => {
  try {
    const got = await call(api.storage.local.get.bind(api.storage.local), key);
    return (got && got[key]) || fallback;
  } catch {
    return fallback;
  }
};
const storeSet = (key, value) =>
  call(api.storage.local.set.bind(api.storage.local), { [key]: value }).catch(() => {});
// Read-modify-write on storage races when events arrive back to back (a download's
// "complete" can land before download() has even returned its id), so every update
// goes through one queue.
let queue = Promise.resolve();
const bump = (key, patch) => {
  const run = async () => {
    const next = { ...(await storeGet(key, {})) };
    for (const [k, v] of Object.entries(patch)) {
      next[k] = typeof v === "function" ? v(next[k]) : v;
    }
    await storeSet(key, next);
    return next;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
};

// ── event log: one writer (this context), many readers (the Log panel) ──────────
const ports = new Set();
let history = [];
const log = (source, text) => {
  const entry = { t: Date.now(), source, text: String(text) };
  history.push(entry);
  if (history.length > 100) history = history.slice(-100);
  for (const p of ports) {
    try {
      p.postMessage({ type: "log", entry });
    } catch {
      ports.delete(p);
    }
  }
};

// ── lifecycle ───────────────────────────────────────────────────────────────────
if (api.runtime && api.runtime.onInstalled) {
  api.runtime.onInstalled.addListener((details) => {
    log("background", `runtime.onInstalled reason=${details && details.reason}`);
    storeSet(KEY.download, {});
    bump(KEY.lifecycle, {
      installReason: (details && details.reason) || "unknown",
      installedAt: Date.now(),
    });
  });
}
if (api.runtime && api.runtime.onStartup) {
  api.runtime.onStartup.addListener(() => {
    log("background", "runtime.onStartup");
    storeSet(KEY.download, {}); // download ids restart with the host
    bump(KEY.lifecycle, { startups: (n) => (n || 0) + 1 });
  });
}
log("background", "worker script evaluated");

// ── messaging: one-shot + Port ──────────────────────────────────────────────────
// Every extension page hears every runtime.sendMessage, so each listener answers
// only the messages addressed to it (`to`) and stays silent (no sendResponse, no
// `return true`) for the rest.
if (api.runtime && api.runtime.onMessage) {
  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.to !== "background") return undefined;
    switch (msg.type) {
      case "ping":
        log("background", "ping from " + (msg.from || "?"));
        // Answer asynchronously: where several pages hear one message, the silent ones
        // conclude at once, and an async answer is the one that arrives last (hosts that
        // settle on the last leg then keep it; Chrome keeps the first real response).
        setTimeout(() => sendResponse({ type: "pong", from: "background", at: Date.now() }), 0);
        return true;
      case "log":
        log(msg.from || "page", msg.text);
        sendResponse({ ok: true });
        return undefined;
      case "xframe-report":
        setTimeout(() => sendResponse({ ...xf }), 0); // async, see "ping"
        return true;
      case "arm-alarm":
        armAlarm()
          .then(sendResponse)
          .catch((e) => sendResponse({ error: e.message }));
        return true; // async response
      case "notify":
        notify(msg.title, msg.message)
          .then(sendResponse)
          .catch((e) => sendResponse({ error: e.message }));
        return true;
      case "download":
        startDownload(msg.url, msg.filename)
          .then(sendResponse)
          .catch((e) => sendResponse({ error: e.message }));
        return true;
      default:
        return undefined;
    }
  });
}

if (api.runtime && api.runtime.onConnect) {
  api.runtime.onConnect.addListener((port) => {
    log("background", `runtime.onConnect port="${port.name}"`);
    if (port.name === "showcase-log") {
      ports.add(port);
      port.onDisconnect.addListener(() => ports.delete(port));
      port.postMessage({ type: "history", entries: history });
      return;
    }
    // Echo port: the panel proves a long-lived channel round-trips.
    port.onMessage.addListener((m) => {
      port.postMessage({ type: "echo", got: m, from: "background", at: Date.now() });
    });
    port.postMessage({ type: "hello", from: "background", port: port.name });
  });
}

// ── cross-frame storage.onChanged (the panel writes, this context must hear it) ─
const xf = { local: 0, session: 0, last: null };
if (api.storage && api.storage.onChanged) {
  api.storage.onChanged.addListener((changes, area) => {
    if (changes["showcase:xframe"]) {
      xf[area] = (xf[area] || 0) + 1;
      xf.last = changes["showcase:xframe"].newValue;
      log("background", `storage.onChanged ${area} showcase:xframe`);
    }
  });
}

// ── alarms ──────────────────────────────────────────────────────────────────────
// Created HERE rather than in a panel: in Chrome any context may create one, but
// this host delivers onAlarm to the context that created it, and this worker is the
// one that counts.
const ALARM = "showcase-tick";
async function armAlarm() {
  if (!api.alarms) throw new Error("chrome.alarms is not available");
  // 0.5 min is Chrome's 30 s floor.
  // periodInMinutes alone: the first tick comes one period (30 s) from now. Chrome
  // also accepts delayInMinutes next to it, but not every host does.
  api.alarms.create(ALARM, { periodInMinutes: 0.5 });
  const alarm = await call(api.alarms.get.bind(api.alarms), ALARM);
  log("background", "alarms.create " + JSON.stringify(alarm));
  return { armed: !!alarm, alarm };
}
if (api.alarms && api.alarms.onAlarm) {
  api.alarms.onAlarm.addListener((alarm) => {
    log("background", `alarms.onAlarm ${alarm.name}`);
    bump(KEY.alarms, { fired: (n) => (n || 0) + 1, last: Date.now() });
  });
}

// ── notifications ───────────────────────────────────────────────────────────────
async function notify(title, message) {
  if (!api.notifications) throw new Error("chrome.notifications is not available");
  const id = await call(api.notifications.create.bind(api.notifications), {
    type: "basic",
    iconUrl: api.runtime.getURL("icon.png"),
    title: title || "DevTools Showcase",
    message: message || "Hello from the showcase extension",
  });
  log("background", "notifications.create -> " + id);
  await bump(KEY.notif, { created: (n) => (n || 0) + 1, lastId: id || null });
  return { id };
}
if (api.notifications) {
  for (const ev of ["onClicked", "onClosed"]) {
    if (api.notifications[ev] && api.notifications[ev].addListener) {
      api.notifications[ev].addListener((id) => {
        log("background", `notifications.${ev} ${id}`);
        bump(KEY.notif, { [ev === "onClicked" ? "clicked" : "closed"]: (n) => (n || 0) + 1 });
      });
    }
  }
}

// ── downloads ───────────────────────────────────────────────────────────────────
async function startDownload(url, filename) {
  if (!api.downloads) throw new Error("chrome.downloads is not available");
  const id = await call(api.downloads.download.bind(api.downloads), {
    url,
    filename,
    saveAs: false,
  });
  log("background", `downloads.download -> id ${id} (${filename})`);
  // `state` may already be "complete" (events can beat this line): only seed it.
  await bump(KEY.download, { id, filename, state: (st) => st || "in_progress" });
  return { id };
}
if (api.downloads && api.downloads.onChanged) {
  api.downloads.onChanged.addListener((delta) => {
    const state = delta.state && delta.state.current;
    if (state) {
      log("background", `downloads.onChanged #${delta.id} ${state}`);
      bump(KEY.download, { id: delta.id, state });
    }
  });
}

// ── webRequest (observe only; blocking is not available on this host) ───────────
const filter = { urls: ["<all_urls>"] };
const observe = (name, field) => {
  const ev = api.webRequest && api.webRequest[name];
  if (!ev || typeof ev.addListener !== "function") return;
  ev.addListener((d) => {
    bump(KEY.webreq, { [field]: (n) => (n || 0) + 1, last: `${d.method} ${d.url}` });
  }, filter);
};
observe("onBeforeRequest", "before");
observe("onCompleted", "completed");
observe("onErrorOccurred", "errors");
