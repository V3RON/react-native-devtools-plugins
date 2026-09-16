# Overview

## The idea

A prototype that wraps the **React Native DevTools frontend (Fusebox)** in Electron and
teaches it enough of Chrome's extension host APIs to run **real Chrome DevTools
Extensions** — GraphQL Network Inspector and Altair GraphQL Client currently load, create
panels, and render. Unpacked Chrome Web Store builds, not rewritten forks.
How it's wired: [ARCHITECTURE.md](ARCHITECTURE.md).

## Background: how an MV3 DevTools extension works

Latest stable extension model is **Manifest V3** (MV2 retired; Chrome 148 adds a `browser.*`
alias, same surface).

```
manifest.json
  devtools_page  → hidden iframe page: the only place `chrome.devtools.*` exists
                   (calls chrome.devtools.panels.create(...))
  background     → MV3 service worker: gets the "browser" APIs
                   (tabs, webRequest, storage, alarms, runtime messaging…)
  content_scripts→ injected into web pages (needs a DOM to inject into)
  action         → toolbar button/popup (browser UI, not DevTools UI)
```

Panel pages (HTML in a DevTools tab) are extension pages too: `chrome.runtime`,
`chrome.storage`, `chrome.i18n`, etc., plus `runtime.sendMessage`/Port to the background.

What real DevTools extensions (React DevTools, Redux DevTools, Apollo/GraphQL tools,
Altair, Lighthouse, Wiztree…) actually rely on, in rough order of importance:

1. `devtools.panels.create` — get a tab. **Universal.**
2. `devtools.network.onRequestFinished` + `Request.getContent()/getHarEntry()` — every
   network/GraphQL/API extension.
3. `devtools.inspectedWindow.eval()` — Redux/MobX/Vuex-style state debuggers reaching
   `window.__*` hooks.
4. `chrome.runtime.sendMessage`/`connect` + `storage` — panel ⇄ background ⇄ outside world.
5. `devtools.panels.elements.createSidebarPane` — object inspector sidebars.
6. `devtools.panels.themeName` / `themeChanged`.
7. `chrome.i18n.getMessage`.
8. Niche: `inspectedWindow.getResources`, `network.getHAR`, `devtools.performance`,
   `devtools.recorder`, `panels.sources`, `tabs`, `notifications`.

## What was achieved

- RN DevTools frontend boots standalone in Electron via a hand-written `InspectorFrontendHost`.
- Unpacked MV3 extensions are served and executed under a custom protocol with
  per-extension scoping.
- A `chrome.*` shim rich enough that real store extensions (GraphQL Network Inspector,
  Altair) load their devtools pages and create panel tabs; `chrome.storage` is fully
  persistent.
- A mechanism (repurposed `setInjectedScriptForOrigin` + per-origin re-injection) for the
  frontend to inject its devtools-API implementation into extension frames.
- A CDP man-in-the-middle (`fake-cdp.js`) to test the stack against web targets.

See [LIMITATIONS.md](LIMITATIONS.md) for what this prototype is *not*.

## The crux: what "inspected window" and "network" mean for React Native

Chrome gives extensions two inspection anchors: a DOM page (`inspectedWindow`) and an HTTP
network log (`network`/`webRequest`). In RN:

| Chrome concept | React Native equivalent | Fidelity |
| --- | --- | --- |
| Inspected page DOM | No DOM. App = Hermes runtime + Fabric tree | Low |
| `inspectedWindow.eval` | CDP `Runtime.evaluate` in the RN JS context — arguably *the* killer feature (inspect global state, call app code) | High, but JSON-serializable values only; no DOM nodes, `objectGroup`/`frameURL` caveats |
| `inspectedWindow.getResources` (source files) | CDP `Debugger.getScriptParsed` — RN scripts map reasonably well | Medium |
| Page navigation (`network.onNavigated`) | No navigations; app relaunch / root re-render | Drop or map to target reload |
| HTTP network log | CDP `Network` domain — **only if the RN runtime emits it**. RN network inspection is opt-in (`unstable_networkInspectionEnabled`, network plugin / `react-native-nitro-fetch` inspector); traffic may bypass the inspected runtime (native fetch, WebSocket, custom GraphQL transport) | Medium at best; the single biggest fidelity gap |
| Request blocking (`webRequest` blocking listeners) | CDP `Fetch` domain — not supported by RN/JSI backends today | Not feasible today |
| "Open this URL" / "open the app" | `shell.openExternal` / deep link to device | Fine |

Consequence: **network-centric extensions (GraphQL Network Inspector, Altair's monitor) can
only be as good as RN's network-inspection story.** Debugger/state-centric extensions
(Redux DevTools style) work surprisingly well via `Runtime.evaluate` + messaging.

## Scope rules

- **Stubbing rule of thumb:** out-of-scope APIs must still exist as inert shapes
  (`addListener` no-ops, methods returning empty results, events that never fire).
  Extensions feature-detect by *calling*; a `TypeError: Cannot read properties of
  undefined` kills the whole panel, a no-op merely degrades it.
- Per-feature tiers and scope decisions live in
  [features/README.md](features/README.md) and the individual feature docs.
