# Documentation structure

Map of the docs tree — what lives where and which file to open for a given question.

```
README.md                                  Project entry: quick start, extension folders, docs links
docs/
├── README.md                              Docs index: status legend (✅🟨🟡❌🚫) + tier definitions
├── STRUCTURE.md                           This file
├── OVERVIEW.md                            The idea & background:
│                                          • why RN DevTools can run Chrome extensions
│                                          • how an MV3 DevTools extension works
│                                          • what was achieved in this prototype
│                                          • "inspected window"/"network" → RN mapping table
│                                          • scope rules (stubbing rule of thumb)
├── ARCHITECTURE.md                        How the current prototype works:
│                                          • main.js, preloads, chrome-runtime.js, fake-cdp.js
│                                          • rozenite:// protocol, injected-script channel
│                                          • data-flow diagram
├── LIMITATIONS.md                         What the prototype is NOT (extension model, API
│                                          fidelity, frontend coupling, security)
├── REFACTORING.md                         Code-structure plan: target src/ layout, layering
│                                          rule, behavior-preserving migration steps
├── ROADMAP.md                             Definition of done (5 levels), 4 implementation
│                                          buckets, recommended build order, guardrails
├── features/
│   ├── README.md                          ★ MASTER STATUS MATRIX — start here for
│   │                                        "what is the state of X?"
│   │                                        (status + tier + blockers per functionality,
│   │                                         dependency graph)
│   ├── DISPATCH-CHANNEL.md                ❌ Host→frontend events (InspectorFrontendAPI,
│   │                                        sendMessageToBackend) — the key prerequisite
│   ├── RUNTIME-MESSAGING.md               🟡 chrome.runtime, Ports, + the cross-cutting
│   │                                        contract rules (lastError, promise/callback, Events)
│   ├── EXTENSION-MANAGEMENT.md            🟡 manifest parsing, ids, install/reload
│   │                                        + manifest-key support matrix
│   ├── DEVTOOLS-PANELS.md                 🟨 panels.create/theme/events, elements sidebars
│   ├── DEVTOOLS-NETWORK.md                🟡 real requests + bodies (rebuild on CDP Network.*)
│   ├── INSPECTED-WINDOW.md                ❌ eval → Runtime.evaluate (state debuggers)
│   ├── STORAGE-AND-I18N.md                🟨 storage areas status + _locales support
│   ├── CONTENT-SCRIPTS.md                 ❌ bridge-runner design: CDP injection +
│   │                                        Runtime.addBinding transport, two-species split
│   ├── BACKGROUND-WORKER.md               ❌ MV3 service worker as always-on hidden frame
│   ├── WEBREQUEST.md                      🟡 observe-only, non-blocking only
│   ├── SMALL-SHIMS.md                     ❌ Tier-2 one-offs: permissions, tabs,
│   │                                        notifications, alarms, downloads, action, options_ui
│   └── TIER3-OMITTED.md                   🚫 deliberately omitted browser APIs +
│                                            "no TypeError kills panels" acceptance test
└── api/
    ├── README.md                          The two host surfaces + shared legend (🔧/🔌/⛔)
    ├── INSPECTOR-FRONTEND-HOST.md         Per-method gap table vs. upstream
    │                                        InspectorFrontendHostAPI.ts (incl. auto-stub fact)
    └── CHROME-EXTENSION-APIS.md           Per-namespace gap table vs. MV3 reference +
                                             cross-cutting contract details
```

## Where do I look for…?

| Question | Open |
| --- | --- |
| What is this project / how does it work? | `OVERVIEW.md` → `ARCHITECTURE.md` |
| What's the state of feature X? | `features/README.md` → the feature's file |
| What must happen before feature X? | same file's `Blocked by` header, or dependency sketch in `features/README.md` |
| How do I work on the roadmap? | `ROADMAP.md` ("Recommended order") |
| Which Chrome method do we stub / miss? | `api/INSPECTOR-FRONTEND-HOST.md` (frontend host), `api/CHROME-EXTENSION-APIS.md` (extension API) |
| What is intentionally NOT supported? | `features/TIER3-OMITTED.md` |
| Why does an extension crash / misbehave? | `LIMITATIONS.md`, then the feature doc's "Current state" |
| How do content scripts get into the app? | `features/CONTENT-SCRIPTS.md` |

## Conventions

- One functionality = one file; status/tier/blockers live in the header table at its top.
- Status legend & tiers: `docs/README.md`. Marks used in `api/` tables:
  ✅ real · 🟡 stub/fake · 🔧 implementable in Electron today · 🔌 needs RN/CDP backend ·
  ⛔ needs dispatch channel.
- Every feature doc ends with a **Definition of done** — status may only flip to ✅ when
  that observable test passes.
- Update the matrix in `features/README.md` whenever a feature doc's status changes;
  keep the "Last reviewed" date fresh.
