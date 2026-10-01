// Page-world probe for tests/extension-frame-electron.test.js.
//
// Deliberately plain page code: whatever it can reach is what an extension
// folder can reach. It reports with `console.log`, which the harness observes
// from the main process (webContents "console-message") — so the probe needs no
// help from the preload, and what it reports is the whole page world of a real
// extension frame, using only APIs a page normally has.
//
// peer.html/peer.js is the same extension's second frame: it answers the
// messaging and Port round-trips below through the host router.
const MARKER = "__ROZENITE_PROBE__";
const chrome0 = window.chrome;
console.log(`${MARKER}${JSON.stringify({ probeStarted: true, url: location.href, hasChrome: Boolean(chrome0) })}`);

const typeOf = (name) => {
  try {
    return typeof window[name];
  } catch (error) {
    return `threw:${error && error.name}`;
  }
};

// Bare identifiers, not just `window.x`: an undeclared global reads "undefined"
// through `typeof` without throwing, which is the honest way to ask.
const bareIpcRenderer = typeof ipcRenderer; // eslint-disable-line no-undef
const bareRequire = typeof require; // eslint-disable-line no-undef
const bareProcess = typeof process; // eslint-disable-line no-undef

// Every check below carries its own deadline, so the probe always reports and
// the report always says WHY something did not settle. A hanging probe would
// cost the harness its whole window and hide every other answer.
const withDeadline = (label, produce, ms = 5000) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    setTimeout(() => done({ deadline: label }), ms);
    try {
      produce(done);
    } catch (error) {
      done({ threw: `${label}: ${error && error.message}` });
    }
  });

Promise.all([
  // 1. An undeclared permission must fail the call, not silently succeed.
  withDeadline("storage.get", (done) =>
    chrome0.storage.local.get("probe-key", () =>
      done((chrome0.runtime.lastError && chrome0.runtime.lastError.message) || "NO lastError")
    )
  ),
  withDeadline("tabs.query", (done) =>
    chrome0.tabs.query({}, () =>
      done((chrome0.runtime.lastError && chrome0.runtime.lastError.message) || "NO lastError")
    )
  ),
  // 2. A webRequest listener from an extension without the permission ends up
  //    withdrawn, so no request data can reach it.
  //
  //    Only the settled state is reported, deliberately:
  //      - `hasListener(fn)` is not an observable from page code — chrome crosses
  //        `contextBridge`, which clones the callback, so the page's function is
  //        never the identity the shim stored (measured, Electron 38; documented in
  //        docs/features/RUNTIME-MESSAGING.md). `hasListeners()` needs no identity.
  //      - whether the listener is *ever* observably registered depends on whether
  //        RUNTIME_REGISTER has answered yet: once it has, the denial is synchronous
  //        and the listener never appears at all. Both outcomes are correct, so the
  //        transient is not a fact worth asserting — the end state is.
  (() => {
    const listener = () => {};
    const ev = chrome0.webRequest.onBeforeRequest;
    ev.addListener(listener, { urls: ["<all_urls>"] });
    return new Promise((resolve) =>
      setTimeout(() => {
        const settled = ev.hasListeners();
        ev.removeListener(listener);
        resolve({ settled });
      }, 300)
    );
  })(),
  // 3. The CSP header the host served for this extension.
  withDeadline("csp-fetch", (done) => {
    fetch("/probe.html", { cache: "no-store" })
      .then(
        (response) => done(response.headers.get("content-security-policy")),
        (error) => done(`fetch failed: ${error.message}`)
      )
      .catch((error) => done(`fetch threw: ${error.message}`));
  }),
  // 4. An inline script under the served policy.
  withDeadline("inline-script", (done) => {
    const script = document.createElement("script");
    script.textContent = "window.__probeInlineRan = true;";
    document.body.appendChild(script);
    setTimeout(() => done(window.__probeInlineRan === true), 150);
  }),
  // 5. Messaging round-trips to the extension's other frame, through the host.
  //    Retried: both frames are siblings and the peer's registration is an async
  //    IPC of its own, so a single send races it — in this shell and in Chrome.
  //    `attempts` is the evidence of which case happened.
  withDeadline(
    "sendMessage",
    (done) => {
    let attempts = 0;
    const send = () => {
      attempts++;
      chrome0.runtime.sendMessage({ type: "probe-ping" }, (response) => {
        if (response && response.type === "probe-pong") {
          done({
            ok: true,
            response,
            attempts,
            lastError: (chrome0.runtime.lastError && chrome0.runtime.lastError.message) || null,
          });
          return;
        }
        if (attempts >= 20) {
          done({
            ok: false,
            attempts,
            response: response || null,
            lastError: (chrome0.runtime.lastError && chrome0.runtime.lastError.message) || null,
          });
          return;
        }
        setTimeout(send, 200);
      });
    };
    send();
    },
    8000
  ),
  // 6. Ports too.
  withDeadline(
    "connect",
    (done) => {
    let attempts = 0;
    const connect = () => {
      attempts++;
      try {
        const port = chrome0.runtime.connect({ name: "probe-port" });
        let settled = false;
        port.onMessage.addListener((message) => {
          if (settled) {
            return;
          }
          settled = true;
          done({ ok: message === "probe-port-pong", message, name: port.name, attempts });
          port.disconnect();
        });
        port.onDisconnect.addListener(() => {
          if (settled) {
            return;
          }
          settled = true;
          port.disconnect();
          if (attempts >= 20) {
            done({
              ok: false,
              attempts,
              error: "no peer on the port",
              lastError: (port.lastError && port.lastError.message) || null,
            });
            return;
          }
          setTimeout(connect, 200);
        });
        port.postMessage("probe-port-ping");
      } catch (error) {
        if (attempts >= 20) {
          done({ ok: false, attempts, error: String(error && error.message) });
          return;
        }
        setTimeout(connect, 200);
      }
    };
    connect();
    },
    8000
  ),
]).then(([storageDenied, tabsDenied, listenerRegistered, cspHeader, inlineRan, messaging, ports]) =>
  console.log(
    `${MARKER}${JSON.stringify({
      url: location.href,
      // No Node / Electron surface in the page world.
      nodeSurface: {
        require: typeOf("require"),
        process: typeOf("process"),
        module: typeOf("module"),
        exports: typeOf("exports"),
        Buffer: typeOf("Buffer"),
        global: typeOf("global"),
        __dirname: typeOf("__dirname"),
        ipcRenderer: typeOf("ipcRenderer"),
      },
      bareIdentifiers: {
        ipcRenderer: bareIpcRenderer,
        require: bareRequire,
        process: bareProcess,
      },
      // chrome.* keeps Chrome's shape even though this extension declares nothing.
      chrome: chrome0
        ? {
            namespaces: Object.keys(chrome0).sort(),
            runtime: ["id", "getURL", "getManifest", "sendMessage", "connect", "onMessage"].map(
              (key) => `${key}:${typeof chrome0.runtime[key]}`
            ),
            devtools: Object.keys(chrome0.devtools || {}).sort(),
            storage: typeof chrome0.storage,
            tabs: typeof chrome0.tabs,
            webRequest: typeof chrome0.webRequest,
            id: chrome0.runtime.id,
          }
        : null,
      storageDenied,
      tabsDenied,
      webRequestListener: listenerRegistered,
      cspHeader,
      inlineScriptRan: inlineRan,
      messaging,
      ports,
    })}`
  )
);

// The probe frame is the caller; tests/fixtures/hardening-probe/peer.html is the
// responder, so every round-trip below crosses two frames through the host.
