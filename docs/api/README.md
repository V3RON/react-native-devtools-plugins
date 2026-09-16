# Host API surfaces vs. this shim

Two host surfaces matter for running Chrome DevTools extensions:

1. **`InspectorFrontendHost`** — the *frontend ⇄ embedder* boundary. The DevTools frontend
   (which RN DevTools' Fusebox is) calls these methods on its host; the host replies by
   dispatching events into `InspectorFrontendAPI` / `InspectorFrontendHost.events`.
   → [INSPECTOR-FRONTEND-HOST.md](INSPECTOR-FRONTEND-HOST.md)
2. **`chrome.*`** — the *extension API* boundary, injected into extension pages (devtools
   page, panel pages, background worker).
   → [CHROME-EXTENSION-APIS.md](CHROME-EXTENSION-APIS.md)

The gap analyses are grounded in current upstream sources:
`front_end/core/host/InspectorFrontendHostAPI.ts` (devtools-frontend) and the MV3
extension API reference (developer.chrome.com, ~90 namespaces).

Legend used in both docs: ✅ implemented in `preload.js`/`src/chrome-shim` ·
🟡 stubbed but fake/inert · 🔧 implementable in Electron today · 🔌 needs RN/CDP backend ·
⛔ architectural gap ([features/DISPATCH-CHANNEL.md](../features/DISPATCH-CHANNEL.md)).

**Feasibility verdict** (can everything be wired?): in [../ROADMAP.md](../ROADMAP.md).
