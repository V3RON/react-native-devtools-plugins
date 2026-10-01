# Roadmap

## Definition of done — "which extensions should work"

Increasing difficulty; each level is a release-worthy milestone:

1. **UI-only extensions** (custom panel + own logic, `storage`, `runtime` messaging):
   Redux-DevTools-style panels, Altair's client tab. → Tier 1.
2. **`eval`-based inspectors** (reach into app globals via `inspectedWindow.eval`): state
   debuggers, `__DEV__` tooling, Hermes-attached profilers. → Tier 1 + faithful eval.
3. **Network inspectors** (GraphQL/Apollo/REST): end-to-end *when* the runtime surfaces
   traffic to CDP; honest degradation when it doesn't. → Tier 1 + RN network quality.
4. **Extensions assuming the DOM/page model** (element sidebars, resource maps,
   content-script round-trips): partial via Tier-2 shims; accept degradation.
5. **Browser-controlling extensions** (ad blockers, request rewriters, scrapers):
   explicitly out of scope → [features/TIER3-OMITTED.md](features/TIER3-OMITTED.md).

## Can we wire *everything* as Chrome expects?

**Shape coverage: yes, 100%. Semantic coverage: yes for everything that doesn't assume a
browser; no for things that do — and that's a product decision, not a technical wall.**

## Implementation buckets

1. **Free (Electron primitives, hours each):** ~~preferences→`electron-store`,
   clipboard, zoom, context menus~~ ✅ done; remaining: save→dialog,
   `shell.openExternal/showItemInFolder`, notifications,
   `dispatchHttpRequest`.
2. **Dispatch channel — the prerequisite (days):** ~~host→frontend events
   (`InspectorFrontendAPI` via IPC)~~ ✅ live. ~~`sendMessageToBackend`→CDP socket~~
   ✅ **resolved differently and closed**: with `?ws=` in the frontend URL the frontend
   talks to the socket directly, so that hook is never called. The shell took the socket
   instead → [cdp-bridge.js](../src/main/cdp-bridge.js)
   ([features/DISPATCH-CHANNEL.md](features/DISPATCH-CHANNEL.md)). Remaining consumers:
   menus/theme events, save flow, workspace, device discovery.
3. **RN/CDP-dependent (weeks; fidelity capped by the backend):**
   ~~`inspectedWindow.eval`~~ ✅ real (`Runtime.evaluate` over the bridge);
   `network`/`webRequest` observability (as good as RN network inspection — the transport
   is now in place, so this is a backend-fidelity question),
   element sidebar panes, **device discovery** (genuinely *better than Chrome* for RN:
   enumerate emulators/devices via the same feed), Sources mapping.
4. **Fundamentally browser-shaped — deliberately don't fake:** DOM content scripts,
   request *blocking* (no CDP `Fetch`), Chrome Sync, `identity` OAuth, Web Store update
   flows, omnibox/toolbar, Recorder. No-op shells + documented divergence.

## Recommended order

```
1. dispatch-channel            (bucket 2; unblocks everything)          ✅ live
2. runtime-messaging + contract rules (promise/callback, lastError, Events, Ports)
3. extension-management        (manifest parse, ids, enumerate to frontend)
4. inspected-window.eval       (state-debugger extensions work)          ✅ done
   └── with it: the CDP bridge, which is now the prerequisite for the next item
5. devtools-network            (real requests/bodies on Network.* → the GraphQL
                                inspector is real; highest-leverage item left)
6. storage session + i18n + small-shims   (crash → degrade for many extensions)
7. background-worker           (unlocks webRequest consumers, alarms, notifications)
8. content-bridge runner       (app-facing extensions with zero app-code changes)
9. panels.elements sidebars, sources, device discovery, save/workspace, i18n polish
```

Independent of order, fix first: ~~**preferences persistence**~~ ✅ done
(`frontend-preferences` via `electron-store`) and the **security substrate**
(below — partially improved: async-IPC house rule in `src/shared/ipc.js`).

## Engineering guardrails

- **Generate, don't hand-write:** derive the `InspectorFrontendHost` object from upstream's
  `InspectorFrontendHostStub` (or its `EventDescriptors`/API type) so the surface can
  never drift from the frontend build; override only what's implemented (upstream
  auto-fills missing methods with stubs, so a curated subset is safe by design).
- **Version pinning:** this surface changes slowly but constantly (`dispatchHttpRequest`,
  AIDA, new-badge telemetry were all added recently). Pin the frontend fork; regenerate
  the coverage matrix in CI (`test/api` in devtools-frontend is the conformance reference).
- **Security debt — mostly paid; what's left:** ~~`sendSync`~~ (gone, the house rule is now
  unconditional), ~~`new Function` on a host-stored script~~ (channel deleted), ~~exposed
  `ipcRenderer`~~, ~~`webSecurity:false`~~ (on, and `rozenite://` proved not to need it off),
  ~~per-extension CSP~~, ~~permission gating~~. Still open, in rough order of value:
  `sandbox: true` (needs one bundled preload file, i.e. a build step), extension frames on
  their own `WebContentsView`/partition so the frontend and extension pages can have
  different policies, and `host_permissions` meaning something. Until sandbox lands, the
  guards limit what an extension page can *ask* for — a renderer compromise is still a Node
  compromise, which is why the background worker and content-script injection are stacked
  *after* this rather than before it.
