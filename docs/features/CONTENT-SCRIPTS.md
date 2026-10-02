# Content scripts (bridge-style)

| | |
| --- | --- |
| **Status** | 🟡 implemented behind an explicit opt-in (`DEVTOOLS_CONTENT_SCRIPTS`), default OFF — see [Implemented: what the design left open](#implemented-what-the-design-left-open); real-device evidence still outstanding |
| **Tier** | 2 — but strategically the most important Tier-2 item |
| **Blocked by** | [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (real now); the CDP transport is real too ([src/main/cdp-bridge.js](../../src/main/cdp-bridge.js)) |
| **Code** | [src/main/content-scripts.js](../../src/main/content-scripts.js) (registry), [src/main/content-gate.js](../../src/main/content-gate.js) (opt-in), [src/main/content-bridge.js](../../src/main/content-bridge.js) (runner + app-side loader) |

## Why this matters

Content scripts are the only standard mechanism by which an extension interacts with the
running target **without the app importing anything**. Without them, every app-facing
extension would need an SDK/import in app code — a non-starter for the "drop in an
unpacked Chrome extension" model.

## What a content script actually is

A plain bundled `.js` file (usually a webpack IIFE — no exports, no special API) shipped
in the extension package, which Chrome evaluates inside a matching page:

```json
"content_scripts": [{
  "matches": ["https://app.example.com/*"],
  "js":  ["dist/content.js"],
  "css": ["dist/overlay.css"],
  "run_at": "document_idle",   // document_start | document_end | document_idle
  "world": "ISOLATED"          // default; "MAIN" supported since Chrome 111
}]
```

Key properties:

- Shares the page **DOM**, but in the default `ISOLATED` world it does **not** share the
  page's JS heap. To hook page globals (`window.__REDUX_DEVTOOLS_EXTENSION__`, React
  internals) the content script injects a second file into the `MAIN` world (classic
  `<script src=chrome.runtime.getURL(...)>` trick, or `"world": "MAIN"`).
- Content scripts receive `chrome.runtime` — so they double as the **bridge**:
  page code ⇄ content script ⇄ `runtime.sendMessage`/Port ⇄ background/panel.

## Two species

| | Species A: DOM manipulators | Species B: main-world bridges / monkey-patchers |
| --- | --- | --- |
| Examples | ad blockers, dark mode, UI tweakers | React DevTools, Redux DevTools, Apollo tools |
| Uses | `document.*`, `MutationObserver`, CSS injection, element events | global-object hooks, patching `fetch`/`XMLHttpRequest`, messaging relay to the panel |
| In RN (Hermes) | 🚫 Dead on arrival — no DOM; do not fake one | **Viable.** RN/Hermes provides `window` (alias with limits), `fetch`, `XMLHttpRequest`, `WebSocket`, timers — the DOM bits they use are only the *injection mechanism*, which our host performs itself via CDP |

## Design: the "content-bridge runner"

1. **Injection**: evaluate the extension's content script source into the attached RN
   target via CDP `Runtime.evaluate` on attach, and re-inject when the frontend reports a
   fresh `executionContextCreated` (Hermes has no `Page.addScriptToEvaluateOnNewDocument`,
   so re-injection is the host's job). A `"world": "MAIN"`-style second file is just a
   second `Runtime.evaluate`.
2. **Isolation**: Hermes/JSC have **no isolated worlds** — everything runs in the app's
   main context. Acceptable for debug bridges (that's what they want); means a bad script
   can pollute app globals. Document it.
3. **Messaging**: Chrome hands content scripts `chrome.runtime` for free; in RN our
   injected loader must polyfill a minimal `chrome.runtime` (`sendMessage`, `connect`,
   `onMessage`) into the app context. **Transport: the existing CDP connection — no
   secondary bridge.** Hermes supports `Runtime.addBinding`, and React Native DevTools
   already uses the addBinding + `Runtime.evaluate` round-trip to pass React DevTools
   data between app and frontend; the content-bridge reuses exactly that channel:
   - host → app: `Runtime.evaluate` / `Runtime.callFunctionOn` into a dispatch function
     installed by the injected loader;
   - app → host: the loader calls the function registered via `Runtime.addBinding`; the
     host receives `Runtime.bindingCalled`.
   This works over USB with physical devices (a `localhost` WebSocket would not), needs
   no extra port/auth, and rides the connection's lifecycle. Two constraints to design
   around: binding payloads are **string-only and fire-and-forget**, so the polyfill
   multiplexes every extension's traffic in one JSON envelope (extension id + sequence
   id for correlating `sendMessage` request/response; base64 for binary), and delivery
   host→app requires the injected loader to have installed its dispatch function first.
4. **Matching**: `matches` URL patterns have no RN analog. Re-key on target metadata the
   frontend already receives (`appIdentifier`, `platform`, `reactNativeVersion` from
   `ReactNativeApplication.metadataUpdated`) plus a host-level `<all_rn_targets>`
   convention.
5. **Degradations**: `css` (no-op), `run_at` granularity (≈ "on attach/first context"),
   `all_frames` / `match_about_blank` (no frames). For **web** targets (e.g. the
   `src/tools/fake-cdp.js` path or future web support), Species A could run nearly for real since a
   DOM exists there.

## Known hard limits

- Hooks installed at attach time miss code that ran before attach (no clean
  `document_start` analog) — the familiar "reload to catch initial state" problem Redux
  DevTools users already know.
- No DOM APIs: any Species-B script that reaches for `document` (even trivially) breaks;
  consider an extremely thin `document` no-op shim to soften the most common cases, and
  nothing more.
- Third-party code executes **inside the user's app process** — heavier security/perf
  story than running it in DevTools; hence the explicit host-level opt-in below, which is
  off until a developer names the extensions that may run.

## Definition of done

A bridge-style content script from an unpacked extension is injected into a running RN
app on attach, hooks a global, and relays app → devtools-panel messages over the existing
CDP connection, with zero app-code changes.

## Implemented: what the design left open

The design above is what shipped, with four decisions it left open now settled. Each is
visible to a developer, so each is stated here rather than only in the code.

### Injection is opted in per extension, and the default is nothing

```bash
DEVTOOLS_CONTENT_SCRIPTS="my-ext.local,other.ext"   # extension ids
DEVTOOLS_CONTENT_SCRIPTS="<all_rn_targets>"         # every scanned extension
```

Unset (the default) injects **nothing at all** and says so once at startup. Third-party
code running inside the user's app is not something that should happen by surprise, so
this is stricter than Chrome by design — Chrome injects whatever a manifest declares.

`matches` patterns do **not** grant permission and never did become a question here: RN
targets are not keyed by URL, so a pattern can only be *reported* (`(informational)`).
Neither does a `content_scripts` entry in `permissions` — Chrome has no such permission
(MV3 rejects the string), so its absence is not read as disapproval and its presence would
not be enough either. What allows injection is the environment opt-in, and nothing else.
The full verdict for every entry of every extension is available from the bridge's
`report()` and is written to the console with the `[content-scripts]` prefix.

### The binding name is reserved, because RN's is session-global

`Runtime.addBinding` dispatches `bindingCalled` by binding **name** alone
(`RuntimeAgent.cpp`), not by context, so one name is one app-wide function and it clobbers
an existing global of that name. `__rozeniteContentBridgeDispatch` is therefore reserved by
this shell, and the host **probes for the binding before injecting** and injects nothing if
the app did not install it. That case is unrecoverable by construction — `sendToHost` is
the only way the loader has to report anything, and the binding is exactly what is missing —
so a shell that injected anyway would be producing scripts that can never talk to anyone.

A fresh `Runtime.executionContextCreated` (or `executionContextsCleared`) means the app has
a context with neither the binding nor the loader — RN's own
`RemovedBindingDoesNotSurviveReload` test is the authority — so the mesh seat is withdrawn
first and injection re-runs. Never a queue of deliveries addressed to a dead context.

### "Nothing answered" is reported as a failure, and `undefined` means a listener answered nothing

Issue #12 had refused to wire `chrome.tabs.sendMessage` rather than let an extension message
itself and read the success as "a page answered". That refusal holds — a tab message never
reaches the sender's own `runtime.onMessage` — and the API now has a real receiver: this
extension's content script, inside the inspected app.

What makes the wiring safe rather than merely convenient is that the app can say it heard
the message and has nobody listening (`nr: true`, plus Chrome's own "Could not establish
connection. Receiving end does not exist." text). The host turns that into a **rejected**
request. A resolved `undefined` is reserved for a listener that genuinely answered nothing,
because that is the one case where it is true. Likewise a response wait that expires says it
expired, and a session that died mid-send stays `pending` with a reason instead of being
reported as answered.

### One loader, merged rather than replaced

The loader is installed once and later runs return early, so a second extension's injection
cannot uninstall the first one's listeners. Each script is wrapped so the `chrome` it sees is
lexical and carries **its own** extension id — otherwise extension B's traffic would be
attributed to extension A. The global `chrome.runtime` belongs to the first extension
injected, and that is stated in the report rather than left to be discovered.

### What is *not* claimed

`npm test` covers the registry, the gate, the loader's semantics (executed in a `node:vm`
"app"), and the host's protocol behaviour against a scripted CDP backend. None of that is
evidence that a script ran inside a real Hermes context: no device run is recorded for this
feature yet, and the `document`-free, `ISOLATED`-world-less, pre-attach-blind limitations
below are properties of the backend, not things a unit test can discharge. Recording one
real run against a real app is what closes the definition of done above.
