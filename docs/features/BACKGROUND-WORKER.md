# Background worker (MV3 service worker)

| | |
| --- | --- |
| **Status** | 🟨 live as an always-on hidden context — script executes, `onInstalled`/`onStartup` fire, worker is a messaging peer; MV3 lifecycle semantics skipped, `tabs`/`notifications`/`action` still inert |
| **Tier** | 2 |
| **Blocked by** | ~~[EXTENSION-MANAGEMENT.md](EXTENSION-MANAGEMENT.md), [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md)~~ (both already lived this) |

## What Chrome does

`background.service_worker` runs in an ephemeral worker context that owns the "browser"
APIs (`tabs`, `webRequest`, `alarms`, `notifications`, `action`…) and is torn down when
idle and woken by events. Many DevTools extensions keep their real logic here — GraphQL
Network Inspector and Altair both ship a `background.js`.

Two properties of Chrome's model matter for a DevTools host:

- the worker is **not** part of DevTools' UI lifecycle: closing the DevTools window does
  not kill it;
- no runtime event reaches the worker before its initial script has finished evaluating —
  the listener it registers at the top level does not exist yet.

## Design here

The worker runs as an **always-on hidden context**: one `BrowserWindow` with
`show: false` per extension that declares a background (`src/main/background-host.js`),
loading a synthesized bootstrap document from the extension's own origin:

```
rozenite://<extension-id>/__rozenite_background__?script=<manifest's script path>&type=<classic|module>
```

The document's only body content is one same-origin `<script src=…>` (with
`type="module"` when the manifest declares `"type": "module"`). It has to be that way:
the extension folder is a **read-only install** — dropping the folder in `extensions/` is
the install step — so the document cannot be written there, and the extension's own CSP
(`script-src 'self'`) refuses an inline `<script>` this host might want to generate. So
`src/main/extension-server.js` synthesizes it in the protocol handler and serves it as a
`Response`. The `?script=` path is resolved through the same containment rules as a real
file request; it is never trusted from the query string.

That hidden window is an ordinary extension frame as far as everything else is concerned:
it uses `extensionFramePreferences()` and the production preload, so the worker gets the
**same `chrome.*` shim**, the same host-derived permission gate, and an ordinary
`RUNTIME_REGISTER` seat in the message router. There is no privileged channel to it.

### Route considered and rejected

The other route was another hidden `<iframe>` inside the frontend — exactly the pattern
`src/frontend/panel-bridge.js` already uses for devtools pages. **Not taken**, for the
first Chrome property above: a background worker is not part of DevTools' UI lifecycle, so
hosting it in the frontend's frame tree would **kill every extension's worker on every
frontend reload or restart** (and any state it holds with it). A `show: false`
`BrowserWindow` is owned by the shell instead of by a page that the user reloads.

That is also the caveat to keep in mind if this is ever revisited: a worker hosted in the
frontend is cheaper (no extra window, no extra renderer) and it is *wrong* — the reload
caveat is not a detail, it is the difference between a background context and a panel.

## Lifecycle

`chrome.runtime.onInstalled` / `onStartup` have producers now. What the host remembers is
`{version, installedAt}` per extension id in `electron-store` (`src/main/install-state.js`,
under `userData`), and the manifest on disk is compared against it at registration:

| Situation | Event delivered |
| --- | --- |
| extension id never seen in this `userData` | `onInstalled({reason: "install"})` |
| stored version ≠ manifest version | `onInstalled({reason: "update"})` |
| nothing changed | `onStartup` (once per host launch) |

Delivered as a new `kind: "lifecycle"` on the existing `RUNTIME_DELIVER` envelope, through
the same `send` closure the router uses for messages, and decided from the manifest the
host read **from disk** — never from anything the frame sent. Whether a frame *is* a
background context is decided from its host-owned URL (`__rozenite_background__` under its
own extension id), so a page cannot claim to be a worker.

**Deliberately skipped** (a superset for a devtools host, and stated rather than implied):

- **idle eviction and event-driven wake.** The context is always-on; nothing suspends it
  and nothing needs to wake it.
- **`onSuspend` / `onUpdateAvailable`** stay registrable and never fire.
- **one lifecycle event per host launch.** A worker frame that reloads gets a new frame and
  no second `install` — nothing was installed the second time.

### App shutdown

Hidden windows are not windows a user can close, so they must not be the reason the shell
stays alive. `src/main/index.js` owns that rule in one place:

- "application windows" = `BrowserWindow.getAllWindows()` minus the host's own worker
  windows (`host.isWorkerWindow(id)`), which is what `activate` and quit-on-last-window
  check;
- because `window-all-closed` **never fires while a hidden worker window is open**, the same
  decision is also made on the last *user* window's `closed` event — otherwise non-mac
  shutdown would hang with the app lingering invisibly;
- `will-quit` closes the worker windows.

So closing the DevTools window quits the app and takes the workers with it, on every
platform. Chrome would keep them alive; this shell does not, because there is nothing here
to keep them *for*.

## Verified

`tests/background-worker-electron.test.js` boots the production shell headless (production
scheme privileges, file server, IPC, `webPreferences`, preload + the production background
host; `show: false`, `DEVTOOLS_CDP_BRIDGE=off`, no Metro, no device, no frontend fork) and
observes, against a fixture extension in a temp extensions dir with a temp
`--user-data-dir`:

1. the worker script **executes** — an ES-module worker whose `import` of a sibling module
   was also fetched over `rozenite://`, with `chrome.runtime.id` correct inside it;
2. `onInstalled{install}` on a fresh `--user-data-dir`, `onInstalled{update}` after the
   staged manifest's version changes with the **same** dir, `onStartup` on a third unchanged
   launch — and `install` + `startup` never both;
3. **panel ⇄ worker** `sendMessage` round-trips, and the answer carries
   `url=/__rozenite_background__` (proof the peer was the worker, not a sibling iframe), and
   a **Port** round-trips both ways;
4. a denied `chrome.tabs.create` inside the worker rejects with the permission message, the
   worker logs the denial itself, and it is **still alive** afterwards;
5. the ESM worker's top-level `chrome.action` / `chrome.notifications` references do not
   break the load, and a background whose script **throws at load is reported**
   (`Uncaught Error: …` in the shell's output) rather than silent.

`tests/background-host.test.js` covers the same decisions without Electron (install/update/
startup, one-event-per-launch, panel frames get nothing, hidden-window options, shutdown
bookkeeping, failure reporting).

Two of the above could not have worked until the verification found them:

- `src/preload/index.js` dispatched on `process.isMainFrame` **first**, so a worker window's
  main frame received the frontend's `InspectorFrontendHost` stub and no `chrome.*`. The
  protocol check comes first now.
- The host pushes `lifecycle` the instant a frame registers — during preload evaluation,
  strictly before the worker's script can register a listener. The frame preload queues
  deliveries until `DOMContentLoaded` (Chrome's rule, for Chrome's reason).

## API surface the worker actually needs

| API | State here |
| --- | --- |
| `runtime` (`id`/`getURL`/`getManifest`/`onMessage`/`connect`/`onInstalled`/`onStartup`) | real |
| `storage.local` / `storage.sync` | real, persistent |
| `storage.session` | **per-frame, not extension-wide** — see [STORAGE-AND-I18N.md](STORAGE-AND-I18N.md) for the consequence this has for Altair |
| `webRequest` | observe-only, permission-gated ([WEBREQUEST.md](WEBREQUEST.md)) |
| `tabs` | **inert**: `create()` resolves `undefined` and opens nothing (issue #4), permission-gated |
| `action`, `notifications` | **`[STUB]` registrable shells** (issue #4): no button, no badge, no popup; `notifications.create` shows nothing and calls back with no id; neither event ever fires |
| `alarms` | not implemented ([SMALL-SHIMS.md](SMALL-SHIMS.md)) |
| `runtime.getBackgroundPage` / `extension.getViews` | honest `undefined` / absent — see below |

### Chrome divergences, stated

- `tabs` **without** the permission. GraphQL declares `["webRequest","storage"]` and no
  `tabs`, so its worker's `chrome.tabs.create(...)` takes this shell's denial path:
  rejected promise + `lastError`, worker keeps running. In Chrome, `chrome.tabs` would not
  be injected at all and the same line would **throw**. Same outcome for the user (no tab
  opens), different failure mode for the extension — shape-first rule,
  [OVERVIEW.md](../OVERVIEW.md).
- `tabs.create` **with** the permission resolves `undefined` and opens nothing. Issue #4
  owns making it open anything.
- **`getBackgroundPage()` returns `undefined`, and `chrome.extension` is not installed at
  all.** Chrome's answer here is also `undefined` for an MV3 extension: a service worker has
  no `window` object to hand out. The host could not fabricate an honest one either — the
  worker's `WebContents` belongs to a window the host does not expose to other frames. `null`
  or a fake window object would both be worse than `undefined`.
- **No sandboxing beyond what panels have.** `sandbox: false` still, so the worker context is
  a separate renderer process, not a sandboxed one ([../LIMITATIONS.md](../LIMITATIONS.md)).

## Why `sample-extension` still has no background

The demo answer is "add one, then you can watch `onInstalled` fire by hand" — and it is
already unnecessary. `npm start` with the shipped folders in place runs **two** real workers,
and their output reaches the shell's terminal with the extension id in front:

- `graphql`'s `onInstalled` handler calls `chrome.tabs.create`, and GraphQL declares no `tabs`
  permission, so a fresh `--user-data-dir` prints the denial (`[graphql] [chrome.tabs]
  permission denied: tabs.create: …`) — which is `onInstalled{install}` firing, visible
  without opening anything;
- `altair`'s worker is an ES module that imports a sibling, so a load-time failure there is
  visible as an uncaught error rather than silence.

Adding a background to `sample-extension` would also cost something specific: it is the
manifest in this repo that demonstrates the two scans are genuinely independent — present in
the devtools-page scan, absent from the background scan. That distinction is asserted
(`tests/extensions-scan.test.js`) and is the property an extension author most needs to trust
when they declare both keys. A third shape in the folder set buys a duplicate demo and loses
the example.

## Definition of done

> GraphQL Network Inspector's `background.js` executes against the shim (its
> `runtime.onInstalled` fires; a fake `tabs.create` call resolves).

**Met, and proven headless** — plus the same for Altair's ESM worker shape (a module worker
with a sibling import and top-level `action`/`notifications` references). `tabs.create` does
not "resolve" for GraphQL, because GraphQL does not declare `tabs`: it rejects with the
permission error and the worker survives, which is the honest version of that clause. The
DoD needed no device: none of "the script executes", "onInstalled fires", or "a message
reaches the worker" involves the inspected app.

Still open, tracked elsewhere:

- `tabs.create` that opens something, real `notifications`, `alarms` → issue #4 /
  [SMALL-SHIMS.md](SMALL-SHIMS.md);
- true MV3 suspended lifecycle (optional refinement, not the DoD);
- extension-wide `storage.session` ([STORAGE-AND-I18N.md](STORAGE-AND-I18N.md)).
