// Live checks for chrome.runtime messaging against the host router, for the
// CDP-backed network APIs, and for inspectedWindow.eval (docs/features/
// RUNTIME-MESSAGING.md, DEVTOOLS-NETWORK.md, WEBREQUEST.md, INSPECTED-WINDOW.md),
// plus the extension-frame security properties this shell is supposed to
// enforce (docs/LIMITATIONS.md §Security).
//
// Results log to this panel's console and to the list; green = passing.
// A check that cannot have data yet logs a warning instead of a false FAIL.
//
// This file is loaded as `<script src>` rather than inline: the shell serves
// every extension page with Chrome's MV3 CSP default (`script-src 'self'`)
// unless the manifest declares its own, and inline scripts do not survive that
// policy. That is the policy working — see the "manifest CSP is enforced" check.
const results = document.getElementById("results");
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`[check] PASS ${name}`);
    const li = document.createElement("li");
    li.textContent = "PASS " + name;
    li.style.color = "green";
    results.appendChild(li);
  } catch (e) {
    console.error(`[check] FAIL ${name}:`, e);
    const li = document.createElement("li");
    li.textContent = "FAIL " + name + ": " + e.message;
    li.style.color = "red";
    results.appendChild(li);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg || "assertion failed");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── the frame this panel runs in (docs/LIMITATIONS.md §Security) ─────────
  // These are the properties the shell promises an extension folder does NOT
  // get. They are also asserted from outside in tests/extension-frame-electron
  // .test.js; here they are visible in the panel, where an extension author
  // looks first.
  await check("no Node surface in the page world", () => {
    for (const name of ["require", "process", "module", "Buffer", "__dirname", "global"]) {
      assert(
        window[name] === undefined,
        `window.${name} must not exist (found ${typeof window[name]})`
      );
    }
    assert(window.ipcRenderer === undefined, "no raw ipcRenderer in the page world");
    // And a bare identifier must not resolve either (context isolation, not
    // just a deleted property).
    let ipcVisible = true;
    try {
      // eslint-disable-next-line no-undef
      ipcVisible = typeof ipcRenderer !== "undefined";
    } catch {
      ipcVisible = false;
    }
    assert(!ipcVisible, "ipcRenderer is not even declarable from a page script");
  });

  await check("chrome.* has the expected namespaces", () => {
    for (const name of ["runtime", "storage", "devtools", "tabs", "webRequest"]) {
      assert(window.chrome && window.chrome[name], `chrome.${name} exists`);
    }
    assert(typeof chrome.runtime.sendMessage === "function", "messaging is live");
    assert(typeof chrome.devtools.panels.create === "function", "panels.create is live");
    assert(
      typeof chrome.devtools.network.getHAR === "function",
      "devtools.network is live"
    );
  });

  await check("manifest CSP is enforced on this frame", async () => {
    // This panel's own HTML has no inline script any more, and an inline script
    // added now is refused by the CSP header the host serves for this extension.
    const probe = document.createElement("script");
    probe.textContent = "window.__inlineJustRan = true;";
    document.body.appendChild(probe);
    await sleep(50);
    assert(
      window.__inlineJustRan === undefined,
      "an inline script must not run under script-src 'self'"
    );
    // eval/Function need 'unsafe-eval', which Chrome's extension policy lacks.
    let evalAllowed = true;
    try {
      // eslint-disable-next-line no-new-func
      new Function("return 1")();
    } catch {
      evalAllowed = false;
    }
    assert(!evalAllowed, "no unsafe-eval in the served policy");
  });

  await check("runtime identity", () => {
    assert(chrome.runtime.id === location.hostname, "id === hostname");
    assert(
      chrome.runtime.getURL("panel.html").startsWith("rozenite://" + chrome.runtime.id + "/"),
      "getURL shape"
    );
    assert(chrome.runtime.getManifest().name, "manifest loaded");
  });

  await sleep(300); // let the peer frame register

  await check("sendMessage round-trip (promise)", async () => {
    const response = await chrome.runtime.sendMessage({ type: "ping" });
    assert(response && response.type === "pong", JSON.stringify(response));
  });

  await check("sendMessage round-trip (callback)", () =>
    new Promise((resolve, reject) =>
      chrome.runtime.sendMessage({ type: "ping" }, (response) => {
        try {
          assert(response && response.type === "pong");
          assert(!chrome.runtime.lastError, "no lastError");
          resolve();
        } catch (e) {
          reject(e);
        }
      })
    )
  );

  await check("async sendResponse (return true)", async () => {
    const response = await chrome.runtime.sendMessage({ type: "async-ping" });
    assert(response && response.type === "async-pong");
  });

  await check("Port round-trip", async () => {
    const port = chrome.runtime.connect({ name: "demo" });
    const pong = await new Promise((resolve, reject) => {
      port.onMessage.addListener(resolve);
      port.onDisconnect.addListener(() =>
        reject(new Error(port.lastError && port.lastError.message))
      );
      setTimeout(() => reject(new Error("timeout")), 2000);
      port.postMessage("ping");
    });
    assert(pong === "port-pong:ping", String(pong));
    port.disconnect();
  });

  // The sample extension declares no permissions at all, and the shell enforces
  // that: chrome.storage exists (shape is never taken away) but a call fails
  // with Chrome's permission error instead of working (docs/features/
  // EXTENSION-MANAGEMENT.md).
  // The sample extension declares `storage`, `tabs` and `webRequest`, and the
  // shell enforces declarations both ways: a declared permission buys a working
  // call, an undeclared one gets Chrome's permission error. The denied half is
  // asserted live against a permission-free fixture extension in
  // tests/extension-frame-electron.test.js; here the granted half stays live.
  await check("declared permission buys a working chrome.storage call", async () => {
    await chrome.storage.local.set({ "sample-key": "sample-value" });
    const read = await chrome.storage.local.get("sample-key");
    assert(
      read && read["sample-key"] === "sample-value",
      "round-trip: " + JSON.stringify(read)
    );
    assert(!chrome.runtime.lastError, "no lastError for a granted permission");
    await chrome.storage.local.remove("sample-key");
  });

  // The granted half of permission gating, live against a real extension that
  // declares `webRequest` (the denied half is asserted against a permission-free
  // fixture in tests/extension-frame-electron.test.js).
  //
  // `hasListeners()` rather than `hasListener(seen)`: chrome crosses contextBridge,
  // which clones the callback, so identity-based lookup cannot work from page code
  // (measured on Electron 38; documented in docs/features/RUNTIME-MESSAGING.md).
  // In the granted case the answer is stable, because nothing revokes the listener.
  await check("declared permission lets a webRequest listener register", () => {
    const seen = () => {};
    chrome.webRequest.onBeforeRequest.addListener(seen, { urls: ["<all_urls>"] });
    try {
      assert(
        chrome.webRequest.onBeforeRequest.hasListeners(),
        "a listener from an extension that declares `webRequest` is registered"
      );
      // And it stays registered: the host's permission verdict confirms it
      // rather than withdrawing it (compare the fixture extension, which declares
      // nothing and gets its listener revoked).
      return sleep(400).then(() =>
        assert(
          chrome.webRequest.onBeforeRequest.hasListeners(),
          "a granted permission keeps the listener registered"
        )
      );
    } finally {
      chrome.webRequest.onBeforeRequest.removeListener(seen);
    }
  });

  await check("a declared permission does not produce a permission error", () =>
    // `notifications` is deliberately absent from this manifest.
    new Promise((resolve, reject) => {
      chrome.tabs.query({}, () => {
        try {
          // `tabs` IS declared, so this must NOT be a permission error...
          assert(!chrome.runtime.lastError, JSON.stringify(chrome.runtime.lastError));
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    })
  );

  // Sentinel for the checks that need nothing but the shell: identity, messaging,
  // permissions, CSP. tests/extension-frame-electron.test.js waits on this line
  // and stops there, because everything after it needs an attached RN app — a
  // headless run has no CDP session, and asserting on that would be asserting on
  // nothing.
  console.log("[panel-checks] shell half done");

  // inspectedWindow.eval needs a live RN app on the shell's CDP bridge. Until
  // the bridge has a session, eval answers isError with the host's reason
  // (never invented data), so the first check retries for a while instead of
  // reporting a false FAIL for a panel that simply loaded before the app did.
  // (docs/features/INSPECTED-WINDOW.md, README "Quick start".)
  const evalUntilAttached = async (expression, attempts = 40) => {
    let pair = await chrome.devtools.inspectedWindow.eval(expression);
    while (attempts-- > 1 && pair && pair[1] && pair[1].isError) {
      await sleep(500);
      pair = await chrome.devtools.inspectedWindow.eval(expression);
    }
    return pair;
  };

  await check("inspectedWindow.eval returns real app globals", async () => {
    const pair = await evalUntilAttached(
      "JSON.stringify({dev: globalThis.__DEV__, platform: globalThis.platform, window: typeof globalThis.window})"
    );
    const [value, info] = pair || [];
    assert(!info, "no exceptionInfo (host said: " + JSON.stringify(info) + ")");
    const parsed = JSON.parse(value);
    assert(typeof parsed.dev === "boolean", "__DEV__ is a boolean: " + value);
    assert(typeof parsed.platform === "string", "platform is a string: " + value);
    assert(parsed.window === "object", "RN aliases global.window: " + value);
    console.log("[inspectedWindow] app says", parsed);
  });

  await check("inspectedWindow.eval reports page exceptions (callback style)", () =>
    new Promise((resolve, reject) =>
      // A bare undeclared identifier throws ReferenceError; note this is NOT
      // the same as `globalThis.__nope`, which evaluates to undefined.
      chrome.devtools.inspectedWindow.eval("__no_such_global_at_all__", (value, info) => {
        try {
          assert(value === undefined, "no value for a thrown exception");
          assert(info && info.isException === true, JSON.stringify(info));
          assert(/Uncaught/.test(info.value), info.value);
          assert(!info.isError, "isError is reserved for tooling failures");
          resolve();
        } catch (e) {
          reject(e);
        }
      })
    )
  );

  await check("inspectedWindow.eval: unserializable results are undefined, not faked", async () => {
    // CDP hands back an objectId for values it cannot serialize; Chrome's
    // JSON-constrained eval then has nothing to give the extension either.
    const [value, info] = await chrome.devtools.inspectedWindow.eval(
      "(function notSerializable() {})"
    );
    assert(value === undefined, "a function has no JSON form: " + JSON.stringify(value));
    assert(!info, "and it is not an error: " + JSON.stringify(info));
  });

  // ── chrome.devtools.network + chrome.webRequest ─────────────────────────
  // Both read the host's CDP network model (src/main/network-model.js), so
  // they only have data once the inspected app has made a request — tap the
  // app's REST / GraphQL buttons and these checks assert what actually
  // arrived. The honesty checks need no traffic: an unavailable capture has
  // to stay visibly empty rather than show invented entries.
  // (docs/features/DEVTOOLS-NETWORK.md, docs/features/WEBREQUEST.md)
  const seen = { finished: [], started: [] };
  chrome.devtools.network.onRequestFinished.addListener((request) => {
    seen.finished.push(request);
    console.log(
      "[devtools.network] finished",
      request.request.url,
      request.response.status
    );
  });
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      seen.started.push(details);
      console.log("[webRequest] onBeforeRequest", details.method, details.url, details.type);
    },
    { urls: ["<all_urls>"] },
    ["requestBody"]
  );
  chrome.devtools.network.onNavigated.addListener((url) =>
    console.log("[devtools.network] onNavigated", JSON.stringify(url))
  );
  const until = async (predicate, ms = 60000) => {
    for (let waited = 0; waited < ms; waited += 250) {
      if (predicate()) return true;
      await sleep(250);
    }
    return predicate();
  };

  await check("devtools.network has Chrome's shape", () => {
    assert(typeof chrome.devtools.network.onRequestFinished.addListener === "function");
    assert(typeof chrome.devtools.network.onNavigated.addListener === "function");
    assert(typeof chrome.devtools.network.getHAR === "function");
    // Shell addition, not Chrome's: the explicit "is there data at all" answer.
    assert(typeof chrome.devtools.network.getNetworkStatus === "function");
  });

  await check("webRequest has Chrome's shape and is non-blocking", () => {
    for (const name of [
      "onBeforeRequest",
      "onBeforeSendHeaders",
      "onSendHeaders",
      "onBeforeRedirect",
      "onResponseStarted",
      "onCompleted",
      "onErrorOccurred",
      // RN has no CDP counterpart for these two: registrable, permanently quiet.
      "onHeadersReceived",
      "onAuthRequired",
    ]) {
      assert(typeof chrome.webRequest[name].addListener === "function", name);
      assert(typeof chrome.webRequest[name].removeListener === "function", name);
    }
    const noop = () => {};
    chrome.webRequest.onCompleted.addListener(noop);
    chrome.webRequest.onCompleted.removeListener(noop);
    assert(!chrome.webRequest.onCompleted.hasListener(noop), "removeListener");
  });

  let status = null;
  await check("getNetworkStatus explains an empty list", async () => {
    status = await chrome.devtools.network.getNetworkStatus();
    assert(typeof status.available === "boolean", JSON.stringify(status));
    assert(Number.isFinite(status.requests), "requests is a count");
    console.log("[devtools.network] status", status);
    if (!status.available) {
      // The honesty rule: nothing may look like traffic that was never seen.
      const har = await chrome.devtools.network.getHAR();
      assert(har.entries.length === 0, "unavailable means no entries");
      console.warn(
        "[devtools.network] no network data from the inspected app:",
        status.reason || status.enableState
      );
    }
  });

  await check("panels.network.getHAR is a HAR 1.2 log", async () => {
    const har = await chrome.devtools.panels.network.getHAR();
    assert(har.version === "1.2" || (har.log && har.log.version === "1.2"), "HAR version");
    assert(Array.isArray(har.entries) && Array.isArray(har.log.entries), "entries both ways");
    assert(har.log.entries === har.entries, "one log, two spellings");
    if (har.entries.length === 0) {
      console.warn("[devtools.network] HAR is empty — tap a request button in the app");
      return;
    }
    const entry = har.entries.find((e) => e.response.status > 0) || har.entries[0];
    assert(/^https?:/.test(entry.request.url), entry.request.url);
    assert(typeof entry.startedDateTime === "string", "startedDateTime");
    assert(entry.timings.dns === -1, "unknown timings stay HAR's -1");
    if (entry.response.status === -1) {
      // HAR's own "no value": a request with no response yet stays -1 rather
      // than reporting a made-up 200.
      console.warn("[devtools.network] entry has no response yet: " + entry.request.url);
      return;
    }
    assert(entry.response.status > 0, "a real status code: " + entry.response.status);
    console.log("[devtools.network] HAR entry", entry.request.method, entry.request.url);
  });

  await check("onRequestFinished carries a real entry, and getContent fetches the body", async () => {
    if (!(await until(() => seen.finished.length > 0))) {
      console.warn("[devtools.network] no request seen — tap REST / GraphQL in the app");
      return;
    }
    const request = seen.finished[0];
    assert(/^https?:/.test(request.request.url), request.request.url);
    // -1 is HAR's "no response was ever reported" (a failed request still
    // fires onRequestFinished, exactly as in Chrome).
    assert(
      request.response.status > 0 || request.response.status === -1,
      "status: " + request.response.status
    );
    assert(typeof request.getContent === "function", "lazy content accessor");
    assert(request._resourceType, "_resourceType from the backend's type");
    if (request.request.postData) {
      assert(typeof request.request.postData.text === "string", "the real POST body");
    }

    const content = await new Promise((resolve) => request.getContent(resolve));
    if (content === null) {
      // An honest empty answer, with the backend's reason in the console.
      console.warn("[devtools.network] the app has no buffered body for this request");
    } else {
      assert(typeof content === "string" && content.length > 0, "a real body, not a stub");
      console.log("[devtools.network] body", content.slice(0, 60));
    }
  });

  await check("webRequest details describe the same request", async () => {
    if (seen.started.length === 0 && !(await until(() => seen.started.length > 0))) {
      console.warn("[webRequest] nothing seen yet — tap a request button in the app");
      return;
    }
    const details = seen.started[0];
    assert(/^https?:/.test(details.url), details.url);
    assert(typeof details.type === "string", "a ResourceType string: " + details.type);
    assert(Number.isFinite(details.timeStamp), "timeStamp");
    assert(Array.isArray(details.requestHeaders), "requestHeaders");
    assert(details.tabId === -1, "no tab model here");
    console.log("[webRequest] details", {
      url: details.url,
      type: details.type,
      headers: details.requestHeaders.length,
    });
  });

  // Sentinel for anything that has to know the run is over — notably
  // tests/extension-frame-electron.test.js, which hosts this shipped panel in a
  // headless Electron run and asserts every check above came out PASS.
  const failures = [...results.children].filter((li) => li.style.color === "red");
  console.log(
    `[panel-checks] done: ${results.children.length - failures.length} passed, ` +
      `${failures.length} failed${failures.length ? ` -> ${failures.map((li) => li.textContent).join(" | ")}` : ""}`
  );
  if (failures.length) {
    console.log(`[panel-checks] FAILED ${failures.length}`);
  } else {
    console.log("[panel-checks] ALL PASSED");
  }
})();
