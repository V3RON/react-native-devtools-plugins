// DevTools Showcase: the main panel.
//
// One card per capability. Each card runs a feature-detected probe and shows a live
// status: "works", "unsupported here" (the API is absent or inert on this host),
// "failed" (it exists and misbehaved) or "ready" (waiting for you to press a button
// or for an event). Nothing throws past its card, so the same file runs in real
// Chrome and in the RN DevTools shell. window.__showcase exposes the results for
// scripted verification.
//
// Loaded as `<script src>`: the shell serves MV3's default CSP (no inline script).
const $ = (sel, root = document) => root.querySelector(sel);
const hasChrome = typeof chrome !== "undefined";
const C = hasChrome ? chrome : {};

// ── helpers ──────────────────────────────────────────────────────────────────────
class Unsupported extends Error {}
// Host says its CDP backend is not attached: unsupported here, not a bug in the extension.
const NO_BACKEND = /CDP bridge is not running|no debugger session|not attached/i;
const unsupported = (why) => new Unsupported(why);
const PROBE_TIMEOUT_MS = 12000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (v, n = 160) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + "..." : String(s);
};

/** Callback-style chrome.* call -> Promise; rejects on runtime.lastError. */
const call = (fn, ...args) =>
  new Promise((resolve, reject) => {
    try {
      fn(...args, (...results) => {
        const err = C.runtime && C.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(results.length > 1 ? results : results[0]);
      });
    } catch (e) {
      reject(e);
    }
  });
const has = (obj, ...path) => {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return false;
    cur = cur[k];
  }
  return cur !== undefined && cur !== null;
};
const isFn = (obj, ...path) => {
  let cur = obj;
  for (const k of path) {
    if (cur == null) return false;
    cur = cur[k];
  }
  return typeof cur === "function";
};
/**
 * Address one peer. Every extension page hears every sendMessage and the others stay
 * silent (Chrome: the first real sendResponse wins). A host that settles on the LAST
 * leg's answer can lose the reply to a silent peer, so an `undefined` reply is retried
 * and then reported as such rather than mistaken for a protocol failure.
 */
const sendTo = async (to, type, extra) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await call(C.runtime.sendMessage.bind(C.runtime), { to, from: "panel", type, ...extra });
    if (r !== undefined) return r;
    await sleep(150);
  }
  throw new LostReply(`no reply from ${to}: a silent peer's empty answer replaced it (sendMessage settles on the last leg here; Chrome keeps the first real response)`);
};
class LostReply extends Unsupported {}
const storeGet = (area, key) => call(C.storage[area].get.bind(C.storage[area]), key).then((g) => g && g[key]);
const storeSet = (area, obj) => call(C.storage[area].set.bind(C.storage[area]), obj);
const bgLog = (text) => {
  try {
    C.runtime.sendMessage({ to: "background", from: "panel", type: "log", text }, () => void C.runtime.lastError);
  } catch {
    /* no background */
  }
};

// ── card model ───────────────────────────────────────────────────────────────────
const results = {}; // id -> {state, text}
const cards = {};
const BADGE = {
  ok: ["ok", "✅ works"],
  warn: ["warn", "⚠️ unsupported here"],
  fail: ["fail", "❌ failed"],
  idle: ["pending", "⏳ ready"],
  pending: ["pending", "⏳ checking"],
};

const addSection = (title) => {
  const h = document.createElement("h2");
  h.textContent = title;
  const grid = document.createElement("div");
  grid.className = "grid";
  $("#sections").append(h, grid);
  return grid;
};

const addCard = (grid, id, name, api, actions = []) => {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = id;
  el.innerHTML =
    '<div class="top"><span class="name"></span><span class="badge pending"></span></div>' +
    '<div class="api"></div><div class="value"></div><div class="actions"></div>';
  $(".name", el).textContent = name;
  $(".api", el).textContent = api;
  for (const [label, fn] of actions) {
    const b = document.createElement("button");
    b.textContent = label;
    b.addEventListener("click", async () => {
      try {
        await fn();
      } catch (e) {
        setResult(id, e instanceof Unsupported ? "warn" : "fail", e.message);
      }
    });
    $(".actions", el).append(b);
  }
  grid.append(el);
  cards[id] = el;
  setResult(id, "pending", "");
};

const renderSummary = () => {
  const count = (s) => Object.values(results).filter((r) => r.state === s).length;
  $("#summary").innerHTML =
    `<span style="color:var(--ok)">✅ ${count("ok")}</span>` +
    `<span style="color:var(--warn)">⚠️ ${count("warn")}</span>` +
    `<span style="color:var(--fail)">❌ ${count("fail")}</span>` +
    `<span class="muted">⏳ ${count("idle") + count("pending")}</span>`;
};

const setResult = (id, state, text) => {
  results[id] = { state, text: text == null ? "" : String(text) };
  const el = cards[id];
  if (el) {
    const [cls, label] = BADGE[state];
    const badge = $(".badge", el);
    badge.className = "badge " + cls;
    badge.textContent = label;
    $(".value", el).textContent = results[id].text;
  }
  renderSummary();
};

/** Run a probe; its return value is the card text, a thrown Unsupported is a warning. */
const probe = async (id, fn) => {
  try {
    // A host API that never answers must not stall the other cards.
    const out = await Promise.race([
      fn(),
      sleep(PROBE_TIMEOUT_MS).then(() => {
        throw unsupported(`no answer within ${PROBE_TIMEOUT_MS / 1000} s (the host never called back)`);
      }),
    ]);
    if (out !== undefined) {
      if (typeof out === "object" && out.state) setResult(id, out.state, out.text);
      else setResult(id, "ok", out);
    }
  } catch (e) {
    setResult(id, e instanceof Unsupported || NO_BACKEND.test(e.message) ? "warn" : "fail", e.message);
  }
};

const eventLog = (text) => {
  const t = new Date().toISOString().slice(11, 23);
  const pre = $("#events");
  pre.textContent += `${t}  ${text}\n`;
  pre.scrollTop = pre.scrollHeight;
  bgLog("panel: " + text);
};

// ── theme (chrome.devtools.panels.themeName / themeChanged) ──────────────────────
const dtPanels = has(C, "devtools", "panels") ? C.devtools.panels : null;
let themeChanges = 0;
const applyTheme = (name, source) => {
  document.documentElement.dataset.theme = name === "dark" ? "dark" : "light";
  return `themeName = ${JSON.stringify(name)} (${source}) -> page is ${document.documentElement.dataset.theme}`;
};

// ── build the cards ──────────────────────────────────────────────────────────────
const tabIdOf = () => (has(C, "devtools", "inspectedWindow", "tabId") ? C.devtools.inspectedWindow.tabId : undefined);
const iw = has(C, "devtools", "inspectedWindow") ? C.devtools.inspectedWindow : null;

const gHost = addSection("Host, theme and panel events");
addCard(gHost, "runtime-info", "Runtime identity", "runtime.id / getManifest / getURL");
addCard(gHost, "theme", "Theme follows DevTools", "devtools.panels.themeName + themeChanged");
addCard(gHost, "visibility", "Panel shown / hidden", "ExtensionPanel.onShown + onHidden");

const gTarget = addSection("Inspected target");
addCard(gTarget, "eval", "Evaluate in the page", "devtools.inspectedWindow.eval", [["Re-run", () => runEval()]]);
addCard(gTarget, "reload", "Reload the target", "devtools.inspectedWindow.reload", [
  [
    "Reload",
    async () => {
      if (!iw || !isFn(iw, "reload")) throw unsupported("inspectedWindow.reload is not available");
      iw.reload({ ignoreCache: true });
      setResult("reload", "ok", "reload({ignoreCache:true}) sent at " + new Date().toLocaleTimeString());
      eventLog("inspectedWindow.reload requested");
    },
  ],
]);
addCard(gTarget, "tabs", "Inspected tab", "tabs.get(inspectedWindow.tabId) / tabs.query");

const gNet = addSection("Network");
addCard(gNet, "net-live", "Requests as they finish", "devtools.network.onRequestFinished");
addCard(gNet, "net-content", "Response body of the latest request", "Request.getContent");
addCard(gNet, "net-har", "HAR snapshot", "devtools.network.getHAR", [["Refresh", () => runHar()]]);
addCard(gNet, "webrequest", "webRequest observers", "webRequest.onBeforeRequest / onCompleted");

const gMsg = addSection("Messaging and lifecycle");
addCard(gMsg, "msg-bg", "Panel to background (sendMessage)", "runtime.sendMessage", [["Ping", () => runMsgBg()]]);
addCard(gMsg, "msg-dev", "Panel to devtools page (sendMessage)", "runtime.sendMessage", [["Ping", () => runMsgDev()]]);
addCard(gMsg, "port", "Long-lived Port to background", "runtime.connect -> Port", [["Send", () => runPort()]]);
addCard(gMsg, "lifecycle", "Background lifecycle events", "runtime.onInstalled / onStartup");
addCard(gMsg, "bridge", "Content-script bridge (opt-in)", "tabs.sendMessage -> content.js", [["Ping", () => runBridge()]]);

const gStore = addSection("Storage and i18n");
addCard(gStore, "storage-local", "storage.local", "storage.local.set/get", [["Bump", () => runStorage("local")]]);
addCard(gStore, "storage-sync", "storage.sync", "storage.sync.set/get", [["Bump", () => runStorage("sync")]]);
addCard(gStore, "storage-session", "storage.session", "storage.session.set/get", [["Bump", () => runStorage("session")]]);
addCard(gStore, "storage-changed", "storage.onChanged", "storage.onChanged");
addCard(gStore, "i18n", "Localized strings", "i18n.getMessage / getUILanguage / getAcceptLanguages / @@ predefined");
addCard(gStore, "xframe", "Cross-frame storage events", "storage.session/local + onChanged in other contexts", [
  ["Write & check", () => runXframe()],
]);

const gBrowser = addSection("Browser APIs");
addCard(gBrowser, "alarms", "Alarms", "alarms.create / get / onAlarm (30 s period)", [["Arm alarm", () => runAlarm()]]);
addCard(gBrowser, "notifications", "Notifications", "notifications.create", [["Notify", () => runNotify()]]);
addCard(gBrowser, "downloads", "Downloads", "downloads.download", [
  ["Save HAR", () => runDownload("har")],
  ["Save JSON", () => runDownload("json")],
]);
addCard(gBrowser, "permissions", "Permissions", "permissions.contains / getAll");
addCard(gBrowser, "options", "Options page", "runtime.openOptionsPage (options_ui)", [
  [
    "Open options",
    async () => {
      if (!isFn(C, "runtime", "openOptionsPage")) throw unsupported("runtime.openOptionsPage is not available");
      await call(C.runtime.openOptionsPage.bind(C.runtime));
      setResult("options", "ok", "openOptionsPage() resolved");
    },
  ],
]);

// ── probes ───────────────────────────────────────────────────────────────────────
const runInfo = () =>
  probe("runtime-info", () => {
    if (!has(C, "runtime", "id")) throw unsupported("chrome.runtime is not available");
    const m = C.runtime.getManifest();
    const host = typeof location !== "undefined" ? location.protocol : "";
    $("#host").textContent = `host protocol ${host} · extension ${C.runtime.id}`;
    return `id ${C.runtime.id}\n${m.name} v${m.version} (MV${m.manifest_version})\n${C.runtime.getURL("panel.html")}`;
  });

/**
 * Subscribe to DevTools theme changes. Chrome's real surface is the method
 * `panels.setThemeChangeHandler(cb)` (Chromium 141 has no `themeChanged` event on
 * `chrome.devtools.panels`); the docs and this host's event-style surface spell it
 * `onThemeChanged` / `themeChanged`. Use whichever exists; returns the mechanism name.
 */
const onThemeChange = (panels, cb) => {
  for (const name of ["themeChanged", "onThemeChanged"]) {
    if (isFn(panels, name, "addListener")) {
      panels[name].addListener(cb);
      return name + ".addListener";
    }
  }
  if (isFn(panels, "setThemeChangeHandler")) {
    panels.setThemeChangeHandler(cb);
    return "setThemeChangeHandler";
  }
  return null;
};
const runTheme = () =>
  probe("theme", () => {
    if (!dtPanels) throw unsupported("chrome.devtools.panels is not available");
    const name = dtPanels.themeName;
    const how = onThemeChange(dtPanels, (n) => {
      if (document.documentElement.dataset.theme === (n === "dark" ? "dark" : "light")) return; // Chrome may notify twice
      themeChanges += 1;
      const text = applyTheme(n, "theme change") + `\nchange handler fired ${themeChanges}x via ${how}`;
      setResult("theme", "ok", text);
      eventLog("theme changed -> " + n);
    });
    if (name === undefined) {
      // Not provided by this host (yet): follow the OS scheme so the page is still usable.
      const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(dark ? "dark" : "default", "prefers-color-scheme fallback");
      return {
        state: "warn",
        text: `themeName is undefined${how ? "" : " and no theme-change hook exists"}; fell back to prefers-color-scheme (${dark ? "dark" : "light"})`,
      };
    }
    return applyTheme(name, "themeName") + (how ? `\nlistening via ${how}` : "\nno theme-change hook on this host");
  });

const VIS = "showcase:visibility";
let vis = { shown: 0, hidden: 0 };
const renderVisibility = async () => {
  const support = (await storeGet("local", "showcase:support:main").catch(() => null)) || {};
  const text = `shown ${vis.shown}x, hidden ${vis.hidden}x, last: ${vis.last || "-"}${vis.gotWindow ? " (onShown got a window)" : ""}`;
  if (support.onShown === false) {
    setResult("visibility", "warn", "ExtensionPanel.onShown is not exposed by this host. " + text);
  } else if (vis.shown > 0 || vis.hidden > 0) {
    setResult("visibility", "ok", text);
  } else if (support.onShown === true) {
    setResult("visibility", "warn", "listeners registered but onShown never fired for this visible panel. " + text);
  } else {
    setResult("visibility", "idle", "waiting for the devtools page to report... " + text);
  }
};
const loadVisibility = async () => {
  const all = (await storeGet("local", VIS).catch(() => null)) || {};
  if (all.main) vis = all.main;
  await renderVisibility();
};

const runEval = () =>
  probe("eval", async () => {
    if (!iw || !isFn(iw, "eval")) throw unsupported("inspectedWindow.eval is not available");
    const expr =
      '(function(){var g=typeof globalThis!=="undefined"?globalThis:window;' +
      'return JSON.stringify({href:typeof location!=="undefined"?location.href:null,' +
      'title:typeof document!=="undefined"?document.title:null,' +
      'demo:g.__showcaseValue||null,' +
      'now:new Date().toISOString()});})()';
    let value, exc;
    // A target that is mid-reload has no execution context yet; retry briefly.
    for (let attempt = 0; attempt < 5; attempt++) {
      [value, exc] = await new Promise((resolve) => iw.eval(expr, (v, e) => resolve([v, e])));
      if (!(exc && (exc.isError || exc.isException))) break;
      await sleep(600);
    }
    if (exc && (exc.isError || exc.isException)) {
      const why = short(exc.description || exc.value || exc);
      return { state: NO_BACKEND.test(why) ? "warn" : "fail", text: why };
    }
    return `eval ->\n${value}`;
  });

const harEntries = (har) => {
  const log = har && (har.log || har);
  return (log && log.entries) || [];
};
const runHar = () =>
  probe("net-har", async () => {
    if (!isFn(C, "devtools", "network", "getHAR")) throw unsupported("devtools.network.getHAR is not available");
    const har = await call(C.devtools.network.getHAR.bind(C.devtools.network));
    const entries = harEntries(har);
    const first = entries[entries.length - 1];
    if (entries.length === 0) return { state: "idle", text: "0 entries so far (press Reload on the target)" };
    return `${entries.length} entries${first ? `\nlatest: ${first.request.method} ${first.request.url} -> ${first.response.status}` : ""}`;
  });

let netSeen = 0;
let harTimer = null;
const runNet = () => {
  if (!isFn(C, "devtools", "network", "onRequestFinished", "addListener")) {
    setResult("net-live", "warn", "devtools.network.onRequestFinished is not available");
    setResult("net-content", "warn", "needs devtools.network");
    return;
  }
  setResult("net-live", "idle", "listening... (press Reload target to generate traffic)");
  setResult("net-content", "idle", "waiting for a request");
  C.devtools.network.onRequestFinished.addListener((req) => {
    netSeen += 1;
    clearTimeout(harTimer);
    harTimer = setTimeout(runHar, 500); // the HAR grows with each finished request
    const r = req.request || {};
    const res = req.response || {};
    setResult("net-live", "ok", `${netSeen} seen\nlatest: ${r.method} ${r.url} -> ${res.status} (${Math.round(req.time || 0)} ms)`);
    eventLog(`onRequestFinished ${r.method} ${r.url} ${res.status}`);
    if (!isFn(req, "getContent")) {
      setResult("net-content", "warn", "Request.getContent is not available");
      return;
    }
    req.getContent((content, encoding) => {
      const err = C.runtime && C.runtime.lastError;
      if (err) return setResult("net-content", "fail", err.message);
      if (content == null) return setResult("net-content", "warn", "body not available for " + r.url);
      setResult("net-content", "ok", `${r.url}\n${short(content, 120)}${encoding ? ` [${encoding}]` : ""}`);
    });
  });
};

const runTabs = () =>
  probe("tabs", async () => {
    if (!isFn(C, "tabs", "get")) throw unsupported("chrome.tabs.get is not available");
    const id = tabIdOf();
    if (id === undefined) throw unsupported("inspectedWindow.tabId is not available");
    const tab = await call(C.tabs.get.bind(C.tabs), id);
    let all = "";
    if (isFn(C, "tabs", "query")) {
      const list = await call(C.tabs.query.bind(C.tabs), {});
      all = `\ntabs.query({}) -> ${list.length} tab(s)`;
    }
    return `tabId ${id}\n${tab.url || "(no url)"}\n${tab.title || ""}${all}`;
  });

const runWebRequest = () =>
  probe("webrequest", async () => {
    if (!has(C, "webRequest", "onCompleted")) throw unsupported("chrome.webRequest is not available");
    C.webRequest.onCompleted.addListener(() => {
      wrLocal += 1;
      refreshWebRequest();
    }, { urls: ["<all_urls>"] });
    await refreshWebRequest();
  });
let wrLocal = 0;
const refreshWebRequest = async () => {
  const local = wrLocal;
  if (!has(C, "webRequest", "onCompleted")) return;
  const bg = (await storeGet("local", "showcase:webreq").catch(() => null)) || {};
  const n = (bg.completed || 0) + local;
  setResult(
    "webrequest",
    n > 0 || bg.before > 0 ? "ok" : "idle",
    `background: ${bg.before || 0} before / ${bg.completed || 0} completed / ${bg.errors || 0} errors\npanel listener: ${local} completed${bg.last ? "\nlast: " + bg.last : ""}`
  );
};

const runMsgBg = () =>
  probe("msg-bg", async () => {
    if (!isFn(C, "runtime", "sendMessage")) throw unsupported("runtime.sendMessage is not available");
    const r = await sendTo("background", "ping");
    if (!r || r.type !== "pong") throw new Error("unexpected reply " + short(r));
    eventLog("sendMessage -> background pong");
    return `reply from ${r.from} at ${new Date(r.at).toLocaleTimeString()}`;
  });
const runMsgDev = () =>
  probe("msg-dev", async () => {
    if (!isFn(C, "runtime", "sendMessage")) throw unsupported("runtime.sendMessage is not available");
    const r = await sendTo("devtools", "ping");
    if (!r || r.type !== "pong") throw new Error("unexpected reply " + short(r));
    return `reply from ${r.from}; its tabId ${r.tabId}, its themeName ${JSON.stringify(r.themeName)}`;
  });

let port = null;
const runPort = () =>
  probe("port", async () => {
    if (!isFn(C, "runtime", "connect")) throw unsupported("runtime.connect is not available");
    if (!port) {
      port = C.runtime.connect({ name: "showcase-panel" });
      port.onDisconnect.addListener(() => {
        port = null;
        setResult("port", "idle", "port disconnected (press Send to reconnect)");
      });
    }
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no reply from the background within 3 s")), 3000);
      const onMsg = (m) => {
        if (m.type !== "echo") return;
        clearTimeout(timer);
        port.onMessage.removeListener(onMsg);
        resolve(m);
      };
      port.onMessage.addListener(onMsg);
      port.postMessage({ n: Date.now(), hello: "from the panel" });
    });
    eventLog("Port echo received");
    return `echo ${short(reply.got, 80)} from ${reply.from}`;
  });

const runLifecycle = async () => {
  const lc = (await storeGet("local", "showcase:lifecycle").catch(() => null)) || {};
  if (lc.installReason) {
    setResult("lifecycle", "ok", `onInstalled reason=${lc.installReason} at ${new Date(lc.installedAt).toLocaleTimeString()}\nonStartup fired ${lc.startups || 0}x`);
  } else {
    setResult("lifecycle", "idle", `onInstalled not observed yet (background may still be starting)\nonStartup fired ${lc.startups || 0}x`);
  }
};

const runBridge = () =>
  probe("bridge", async () => {
    if (!isFn(C, "tabs", "sendMessage")) throw unsupported("tabs.sendMessage is not available");
    const id = tabIdOf();
    if (id === undefined) throw unsupported("no inspected tab id");
    try {
      const r = await call(C.tabs.sendMessage.bind(C.tabs), id, { type: "showcase-ping" });
      if (!r || r.type !== "showcase-pong") {
        return { state: "warn", text: "no content script answered: " + short(r) };
      }
      return `content script answered from ${r.where}`;
    } catch (e) {
      // The expected, honest answer when content scripts are not injected.
      return {
        state: "warn",
        text: `no content script in the target (${e.message}). In the shell it is opt-in: DEVTOOLS_CONTENT_SCRIPTS=showcase`,
      };
    }
  });

let changedCount = 0;
const runStorageChanged = () => {
  if (!has(C, "storage", "onChanged")) return setResult("storage-changed", "warn", "storage.onChanged is not available");
  C.storage.onChanged.addListener((changes, area) => {
    changedCount += 1;
    setResult("storage-changed", "ok", `${changedCount} change event(s)\nlast: ${area} ${Object.keys(changes).join(", ")}`);
  });
  setResult("storage-changed", "idle", "listening; press a Bump button (events from other frames may not reach this host)");
};

const runStorage = (area) =>
  probe("storage-" + area, async () => {
    if (!has(C, "storage", area)) throw unsupported(`chrome.storage.${area} is not available`);
    const key = `showcase:${area}-probe`;
    const prev = Number(await storeGet(area, key)) || 0;
    await storeSet(area, { [key]: prev + 1 });
    const back = Number(await storeGet(area, key));
    if (back !== prev + 1) throw new Error(`wrote ${prev + 1}, read back ${back}`);
    return `${key}: ${prev} -> ${back} (round-trip OK)`;
  });

const runI18n = () =>
  probe("i18n", async () => {
    if (!isFn(C, "i18n", "getMessage")) throw unsupported("chrome.i18n is not available");
    const g = (k, subs) => C.i18n.getMessage(k, subs);
    const name = g("extName");
    if (!name) {
      return { state: "warn", text: `getMessage("extName") is empty: _locales not served on this host` };
    }
    const lang = isFn(C, "i18n", "getUILanguage") ? C.i18n.getUILanguage() : "?";
    const accept = isFn(C, "i18n", "getAcceptLanguages")
      ? await call(C.i18n.getAcceptLanguages.bind(C.i18n)).catch(() => null)
      : null;
    const lines = [
      `${name} / locale name: ${g("localeName")} / UI language ${lang}`,
      `placeholder: ${g("greeting", "Ada")}  |  $1 $2: ${g("pair", ["2", "5"])}`,
      `fallback (default_locale): ${g("fallbackProbe") || "(empty)"}`,
      `@@ui_locale=${g("@@ui_locale") || "-"} @@extension_id=${(g("@@extension_id") || "-").slice(0, 12)} @@bidi_dir=${g("@@bidi_dir") || "-"}`,
      `getAcceptLanguages: ${accept ? accept.join(",") : "(unavailable)"}`,
    ];
    return lines.join("\n");
  });

const runXframe = () =>
  probe("xframe", async () => {
    if (!has(C, "storage", "session") || !has(C, "storage", "local")) throw unsupported("storage.session/local missing");
    const stamp = { n: Date.now(), from: "panel" };
    await storeSet("session", { "showcase:xframe": stamp });
    await storeSet("local", { "showcase:xframe": stamp });
    await sleep(600);
    const bg = await sendTo("background", "xframe-report").catch(() => null);
    const dev = await sendTo("devtools", "xframe-report").catch(() => null);
    const fmt = (r) => (r ? `session ${r.session}x, local ${r.local}x` : "no reply");
    const seen = (r) => !!r && r.session > 0 && r.local > 0;
    const sessionBack = await storeGet("session", "showcase:xframe");
    const text = `wrote session+local\nbackground heard: ${fmt(bg)}\ndevtools page heard: ${fmt(dev)}\nsession readable back: ${!!sessionBack}`;
    if (seen(bg) && seen(dev)) return text;
    return { state: "warn", text: text + "\n(other contexts did not receive both onChanged events: per-frame storage here)" };
  });

const runAlarm = () =>
  probe("alarms", async () => {
    const r = await sendTo("background", "arm-alarm");
    if (r && r.error) throw r.error.includes("not available") ? unsupported(r.error) : new Error(r.error);
    eventLog("alarm armed " + short(r.alarm, 80));
    return { state: "idle", text: `armed ${short(r.alarm, 120)}; waiting for the first tick (~30 s)` };
  });
const refreshAlarm = async () => {
  const a = await storeGet("local", "showcase:alarms").catch(() => null);
  if (a && a.fired) setResult("alarms", "ok", `onAlarm fired ${a.fired}x, last ${new Date(a.last).toLocaleTimeString()}`);
};

const runNotify = () =>
  probe("notifications", async () => {
    const r = await sendTo("background", "notify", { title: "DevTools Showcase", message: "Hello from the panel" });
    if (r && r.error) throw r.error.includes("not available") ? unsupported(r.error) : new Error(r.error);
    if (!r.id) return { state: "warn", text: "notifications.create ran but no id came back (the platform refused to show it)" };
    return `notification id ${r.id}`;
  });
const refreshNotif = async () => {
  const n = await storeGet("local", "showcase:notif").catch(() => null);
  if (n && n.created && !n.lastId) {
    setResult("notifications", "warn", `created ${n.created}x but no id came back: the platform cannot show notifications here`);
  } else if (n && n.created) {
    setResult("notifications", "ok", `created ${n.created}x, id ${n.lastId}; clicked ${n.clicked || 0}x, closed ${n.closed || 0}x`);
  }
};

const runDownload = (kind) =>
  probe("downloads", async () => {
    let body, filename;
    if (kind === "har") {
      if (!isFn(C, "devtools", "network", "getHAR")) throw unsupported("no HAR source (devtools.network.getHAR missing)");
      const har = await call(C.devtools.network.getHAR.bind(C.devtools.network));
      const log = har && har.log ? har.log : har;
      body = JSON.stringify({ log }, null, 2);
      filename = "showcase.har";
    } else {
      body = JSON.stringify({ from: "devtools-showcase", at: new Date().toISOString(), results }, null, 2);
      filename = "showcase-results.json";
    }
    const url = "data:application/json;base64," + btoa(unescape(encodeURIComponent(body)));
    const r = await sendTo("background", "download", { url, filename });
    if (r && r.error) throw r.error.includes("not available") ? unsupported(r.error) : new Error(r.error);
    eventLog(`download started #${r.id} ${filename} (${body.length} bytes)`);
    return { state: "idle", text: `download #${r.id} requested: ${filename} (${body.length} bytes)` };
  });
const refreshDownload = async () => {
  const d = await storeGet("local", "showcase:download").catch(() => null);
  if (d && d.state === "complete") setResult("downloads", "ok", `download #${d.id} complete: ${d.filename}`);
  else if (d && d.state === "interrupted") setResult("downloads", "fail", `download #${d.id} interrupted`);
};

const runPermissions = () =>
  probe("permissions", async () => {
    if (!has(C, "permissions", "contains")) throw unsupported("chrome.permissions is not available");
    const yes = await call(C.permissions.contains.bind(C.permissions), { permissions: ["storage"] });
    const no = await call(C.permissions.contains.bind(C.permissions), { permissions: ["bookmarks"] });
    const all = await call(C.permissions.getAll.bind(C.permissions));
    if (yes !== true || no !== false) throw new Error(`contains(storage)=${yes}, contains(bookmarks)=${no}`);
    return `contains(storage)=true, contains(bookmarks)=false\ngetAll: ${(all.permissions || []).join(", ")}`;
  });

// ── visibility / theme messages from the devtools page ───────────────────────────
if (has(C, "runtime", "onMessage")) {
  C.runtime.onMessage.addListener((m) => {
    if (m && m.to === "panel" && m.type === "visibility" && m.panelName === "main") {
      vis = m.state;
      renderVisibility();
      eventLog(`panel ${m.kind} (shown ${vis.shown}x / hidden ${vis.hidden}x)`);
    }
    return undefined;
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────────
const refreshShared = async () => {
  await Promise.all([runLifecycle(), refreshAlarm(), refreshNotif(), refreshDownload(), refreshWebRequest(), loadVisibility()]);
};

(async () => {
  try {
    const t = C.i18n && C.i18n.getMessage("panelTitle");
    if (t) $("#title").textContent = "DevTools Showcase · " + t;
  } catch {
    /* i18n unsupported */
  }
  eventLog("panel loaded");
  await runInfo();
  await runTheme();
  runNet();
  runStorageChanged();
  await Promise.all([runEval(), runHar(), runTabs(), runWebRequest(), runPermissions(), runI18n()]);
  await sleep(300); // let the peer frames (devtools page, background) register
  await Promise.all([runMsgBg(), runMsgDev(), runPort(), runBridge()]);
  await Promise.all([runStorage("local"), runStorage("sync"), runStorage("session")]);
  await runXframe();
  setResult("reload", "idle", "press Reload to reload the inspected target");
  setResult("alarms", "idle", "press Arm alarm; the background counts the ticks");
  setResult("notifications", "idle", "press Notify");
  setResult("downloads", "idle", "press Save HAR or Save JSON");
  setResult("options", "idle", "press Open options");
  await refreshShared();
  setInterval(refreshShared, 1500);
  // Give onShown a moment, then re-evaluate (so "never fired" is a fact, not a race).
  setTimeout(renderVisibility, 2500);
})();

window.__showcase = { results, cards: () => Object.keys(cards), refreshShared };
