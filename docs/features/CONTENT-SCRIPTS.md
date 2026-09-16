# Content scripts (bridge-style)

| | |
| --- | --- |
| **Status** | ❌ not implemented (design agreed) |
| **Tier** | 2 — but strategically the most important Tier-2 item |
| **Blocked by** | [DISPATCH-CHANNEL.md](DISPATCH-CHANNEL.md), [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) |

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
   `fake-cdp.js` path or future web support), Species A could run nearly for real since a
   DOM exists there.

## Known hard limits

- Hooks installed at attach time miss code that ran before attach (no clean
  `document_start` analog) — the familiar "reload to catch initial state" problem Redux
  DevTools users already know.
- No DOM APIs: any Species-B script that reaches for `document` (even trivially) breaks;
  consider an extremely thin `document` no-op shim to soften the most common cases, and
  nothing more.
- Third-party code executes **inside the user's app process** — heavier security/perf
  story than running it in DevTools; gate behind an explicit per-extension permission in
  the host UI.

## Definition of done

A bridge-style content script from an unpacked extension is injected into a running RN
app on attach, hooks a global, and relays app → devtools-panel messages over the existing
CDP connection, with zero app-code changes.
