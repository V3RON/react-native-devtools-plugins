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
5. `devtools.panels.elements.createSidebarPane` — object inspector sidebars. 🚷 **No anchor:**
   RN DevTools has no Elements panel (no DOM), so there is no selection to hang a sidebar on →
   [the anchor list](#what-rn-devtools-actually-offers-the-anchor-list).
6. `devtools.panels.themeName` / `setThemeChangeHandler`.
7. `chrome.i18n.getMessage`.
8. Niche: `inspectedWindow.getResources` (implementable), `network.getHAR`, `devtools.performance`
   (implementable), `devtools.recorder` 🚫, `panels.sources` (implementable), `tabs`,
   `notifications`.

## What was achieved

- RN DevTools frontend boots standalone in Electron via a hand-written `InspectorFrontendHost`.
- Unpacked MV3 extensions are served and executed under a custom protocol with
  per-extension scoping.
- A `chrome.*` shim rich enough that real store extensions (GraphQL Network Inspector,
  Altair) load their devtools pages and create panel tabs; `chrome.storage` is fully
  persistent.
- A mechanism (repurposed `setInjectedScriptForOrigin` + per-origin re-injection) for the
  frontend to inject its devtools-API implementation into extension frames.
- A CDP man-in-the-middle (`src/tools/fake-cdp.js`) to test the stack against web targets.
- The shell holds the RN debugger session itself (`src/main/cdp-bridge.js`: Metro target
  discovery, re-attach, host commands multiplexed by message id onto the frontend's
  session), which makes `chrome.devtools.inspectedWindow.eval` return real values from a
  running app — the first working bridge to the target.
- An extension's `background.js` **runs**. Each extension that declares a background gets an
  always-on hidden window against the same shim, with `runtime.onInstalled`/`onStartup` firing
  and the worker as an ordinary messaging peer — which is the context GraphQL's and Altair's
  real logic lives in (`src/main/background-host.js`,
  [features/BACKGROUND-WORKER.md](features/BACKGROUND-WORKER.md)).

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
| Elements panel + selected DOM node | **No Elements panel, no `DOM` domain** — 🚷 no anchor (see [the anchor list](#what-rn-devtools-actually-offers-the-anchor-list)) | None; React Components is a React tree, not a DOM tree |

Consequence: **network-centric extensions (GraphQL Network Inspector, Altair's monitor) can
only be as good as RN's network-inspection story.** Debugger/state-centric extensions
(Redux DevTools style) work surprisingly well via `Runtime.evaluate` + messaging.

## What RN DevTools actually offers: the anchor list

Chrome's extension APIs are all anchored on a **panel or a browser surface** the extension
attaches to. React Native DevTools ships a known, closed set of those, and it is *smaller*
than Chrome's — most of all, it has **no Elements panel**, because there is no DOM: the app is
a Hermes runtime plus a Fabric tree, and jsinspector-modern implements no `DOM`/`Overlay`
domains. This table is the single source of truth for that; every 🚷 mark in these docs means
"the row this API is anchored on does not exist here".

| RN DevTools panel (RN 0.83+) | Backing CDP | What it anchors |
| --- | --- | --- |
| Console | `Runtime`, `Log` | `inspectedWindow.eval` ✅ real |
| Sources | `Debugger`, `Network` for source maps | `panels.sources`, `inspectedWindow.getResources` — implementable |
| Network (since 0.83) | `Network` (opt-in on the backend) | `devtools.network`, `webRequest` — real, fidelity-capped |
| Performance (since 0.83) | tracing | `panels.performance` — implementable |
| Memory | `HeapProfiler` | (no extension API anchored on it) |
| React Components / Profiler | React DevTools, integrated | *not* the Elements panel: it is React's own tree, not a DOM tree an extension can select from |
| — **Elements: does not exist** | no `DOM` domain | ✂ `panels.elements.*`, `inspectedWindow.getSelectedNode`, `enterInspectElementMode`, element selection, inspect-element mode |
| — **A page / document: does not exist** | no `Page` document model (only `Page.reload` for the bundle) | ✂ DOM content scripts, `chrome.scripting`, `panels.elements.openResource`'s resource map |
| — **Browser chrome UI: does not exist** | — | ✂ toolbar/`action` popup, omnibox, real `contextMenus`, `sidePanel` drawer, shortcut routing |

Two consequences worth stating before any planning:

1. **Anything anchored on the ✂ rows is out of reach by construction, not by effort.** We keep
   the *shape* alive (the stubbing rule below) so extensions degrade instead of dying, and mark
   them 🚷 rather than leaving them on a to-do list.
2. **The React Components panel is not a substitute.** It is a React-owned tree inside an
   integrated React DevTools, not the `Elements` panel's DOM tree — there is no
   `Runtime.RemoteObjectId` for "the node the user selected", and no host-level selection to
   hang `createSidebarPane` off. Mapping the sidebars there would be a *new product feature*
   (Fabric-tree selection + a new CDP-ish channel), not Chrome API fidelity, so it is scoped
   out of this collaboration rather than parked as an open item.

See also [features/TIER3-OMITTED.md](features/TIER3-OMITTED.md) for the browser-side half of
the same argument, and [features/DEVTOOLS-PANELS.md](features/DEVTOOLS-PANELS.md) for the
per-method marks.

Sources for the panel list: the RN docs ("React Native DevTools" — Console, Sources, Network
since 0.83, Performance since 0.83, Memory, plus the integrated React Components/Profiler; no
Elements), and the shipped frontend this shell loads (`DEVTOOLS_FRONTEND_URL`, i.e. the fork's
`rn_fusebox.html`), which is the version that actually has to agree. Verify against a device
before planning anything on top of this table — same rule as everywhere else in these docs.

## Scope rules

- **Stubbing rule of thumb:** out-of-scope APIs must still exist as inert shapes
  (`addListener` no-ops, methods returning empty results, events that never fire).
  Extensions feature-detect by *calling*; a `TypeError: Cannot read properties of
  undefined` kills the whole panel, a no-op merely degrades it.
- Per-feature tiers and scope decisions live in
  [features/README.md](features/README.md) and the individual feature docs.
