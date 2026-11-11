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
   content-script round-trips): partial via Tier-2 shims; accept degradation. **Reclassified
   2026-10-14:** the element-sidebar half of this level has *no anchor* — RN DevTools has no
   Elements panel — so it is out of the definition of done, not a degraded level. Level 4 now
   means "resource maps and bridge-style content scripts degrade honestly". See
   [OVERVIEW.md's anchor list](OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list).
5. **Browser-controlling extensions** (ad blockers, request rewriters, scrapers):
   explicitly out of scope → [features/TIER3-OMITTED.md](features/TIER3-OMITTED.md).

## What we can actually implement (the pruned list)

Checked against the panels RN DevTools really ships (Console, Sources, Network since 0.83,
Performance since 0.83, Memory, React Components, React Profiler — **no Elements**). Everything
below has an anchor:

| # | Item | Why it's now real work |
| --- | --- | --- |
| 1 | **The device run**: verify `devtools.network` + `webRequest` *and* the `inspectedWindow.eval` live checks from this checkout | all three are implemented and unit-covered; the app-side half has never been walked against a device here, and until it passes those statuses stay 🟨 ("unrun = unverified"). Closes the highest-leverage Tier-1 item |
| 2 | **`sandbox: true`** (bundled preload = the one build step) | the guardrail content-script injection is stacked behind |
| 3 | **Manifest-driven content-script injection** (drop the `DEVTOOLS_CONTENT_SCRIPTS` opt-in once #2 lands) + a thin `document` no-op shim | the runner is real and device-proven; today it injects only what a developer whitelists by hand |
| 4 | **`panels.network.getHAR`** | the HAR builder already exists; one more exposed name |
| 5 | **`panels.sources.openInFrontend`** + `inspectedWindow.getResources` / `getResourceContent` | RN DevTools has a Sources panel; `Debugger.getScriptParsed` is the source |
| 6 | **`panels.performance.onRecordingStarted/Stopped`** | RN DevTools has the Performance panel; needs the frontend's recording state on the dispatch channel |
| 7 | **`commands.onCommand`** via the Electron app menu / `before-input-event` | the only shell-UI event with a producer writable in-process |
| 8 | **Device discovery** (`setDevicesDiscoveryConfig` → `devicesUpdated`) | "better than Chrome": adb/simctl/Metro targets |
| 9 | **`dispatchHttpRequest`** | trivial over `net`/`fetch`; the last free item in bucket 1 |
| 10 | **Extension lifecycle UI** (install / reload / permissions prompt) + a folder watcher | nothing else changes: dropping a folder is the install flow today |
| 11 | **A `chrome.windows` inert shell** | the last place the stubbing rule still breaks (a worker naming it dies at load) |
| 12 | **Productization**: package the frontend fork instead of loading it from Metro at a fixed port; multi-target/multiplexing | today stock RN DevTools + this shell = no extension support |
| 13 | **Remaining security items**: extension frames on their own `WebContentsView`/partition, `host_permissions` enforcement, per-extension origin isolation for `rozenite://` | see the guardrails section |

**Closed as 🚷 "no anchor" — removed from this list, inert shapes stay:**
`panels.elements.*` (sidebars, `inspectedObject`, `openResource`, `onCreateContextMenu`),
`inspectedWindow.getSelectedNode`, `action` popups/`onClicked`, `contextMenus.onClicked`,
`sidePanel.open`, the `tabs` lifecycle events and `captureVisibleTab`, **blocking**
`webRequest` and `declarativeNetRequest`, DOM content scripts and `chrome.scripting`,
`webNavigation`, `devtools.recorder`, `chrome.windows` real behavior. Full table:
[features/README.md](features/README.md#-closed-as-no-anchor--not-open-items).

## Can we wire *everything* as Chrome expects?

**Shape coverage: yes, 100%. Semantic coverage: yes for everything that doesn't assume a
browser; no for things that do — and that's a product decision, not a technical wall.**

One refinement, added 2026-10-14: the "assumes a browser" line has a second, tighter failure
class. Some APIs don't assume a *browser*, they assume a **DevTools panel RN DevTools does not
ship** — above all the Elements panel, which is what the whole `panels.elements.*` /
`getSelectedNode` family hangs off. Those are 🚷 "no anchor": no shim work and no RN backend
work makes them meaningful, so they are closed rather than planned. See
[the anchor list](OVERVIEW.md#what-rn-devtools-actually-offers-the-anchor-list) and the
[pruned open-items list](#what-we-can-actually-implement-the-pruned-list).

## Implementation buckets

1. **Free (Electron primitives, hours each):** ~~preferences→`electron-store`,
   clipboard, zoom, context menus~~ ✅ done; ~~save→dialog, notifications,
   `shell.openExternal` (as `tabs.create`'s policy-gated open)~~ ✅ done via Tier 2
   (`src/main/save-service.js`, `notification-host.js`, `tab-host.js`). Deliberately NOT
   done: `shell.showItemInFolder` and a downloads "reveal" — the frontend/extension names a
   path this host did not write, so revealing anything would mislead. Remaining:
   `dispatchHttpRequest`.
2. **Dispatch channel — the prerequisite (days):** ~~host→frontend events
   (`InspectorFrontendAPI` via IPC)~~ ✅ live. ~~`sendMessageToBackend`→CDP socket~~
   ✅ **resolved differently and closed**: with `?ws=` in the frontend URL the frontend
   talks to the socket directly, so that hook is never called. The shell took the socket
   instead → [cdp-bridge.js](../src/main/cdp-bridge.js)
   ([features/DISPATCH-CHANNEL.md](features/DISPATCH-CHANNEL.md)). ~~menus/theme events,
   save flow~~ real already (`showContextMenuAtPoint`, `colorThemeChanged`, the `savedURL`
   family). Remaining producers: workspace, device discovery.
3. **RN/CDP-dependent (weeks; fidelity capped by the backend):**
   ~~`inspectedWindow.eval`~~ ✅ real (`Runtime.evaluate` over the bridge);
   `network`/`webRequest` observability (as good as RN network inspection — the transport
   is now in place, so this is a backend-fidelity question),
   **device discovery** (genuinely *better than Chrome* for RN: enumerate emulators/devices
   via the same feed), Sources mapping (`panels.sources`, `inspectedWindow.getResources`).
   ~~element sidebar panes~~ **moved out of this bucket 2026-10-14: 🚷 no anchor** — the
   panes live under the Elements panel, which RN DevTools does not have.
4. **Fundamentally browser-shaped — deliberately don't fake:** DOM content scripts, Chrome
   Sync, `identity` OAuth, Web Store update flows, omnibox/toolbar, Recorder. No-op shells +
   documented divergence.
5. **No anchor in RN DevTools — cannot be made real at any effort (🚷):** the Elements-panel
   family (`panels.elements.*`, `inspectedWindow.getSelectedNode`), request *blocking* and
   `declarativeNetRequest` (no CDP `Fetch` in the RN backend), the browser-chrome event family
   (`action.onClicked`, `contextMenus.onClicked`, `sidePanel.open`, the `tabs` lifecycle
   events, `captureVisibleTab`, `chrome.windows`), DOM content scripts and `chrome.scripting`,
   `webNavigation`, `devtools.recorder`. These were pruned from the buckets above on
   2026-10-14; they keep inert shapes and are **not** open items.
   Table: [features/README.md](features/README.md#-closed-as-no-anchor--not-open-items).

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
7. ~~background-worker~~ (unlocks webRequest consumers, alarms, notifications)  ✅ live —
   always-on hidden context per extension, lifecycle events fire, worker is a router peer
   (`docs/features/BACKGROUND-WORKER.md`); the browser APIs it wants (`tabs`,
   `notifications`, `alarms`) are the next thing that actually unblocks anything
8. content-bridge runner       (app-facing extensions with zero app-code changes)  🟨 the
   runner is real and observed on a device, but injection is opt-in
   (`DEVTOOLS_CONTENT_SCRIPTS`); making it manifest-driven is stacked behind `sandbox: true`
9. the pruned list above: device discovery, panels.sources / panels.performance,
   panels.network.getHAR, commands.onCommand, lifecycle UI, save/workspace, i18n polish
   └── ~~panels.elements sidebars~~ 🚷 removed 2026-10-14: no Elements panel to anchor on
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
  **Deviation, recorded:** the background worker landed *before* `sandbox: true`. It was
  stacked after this guardrail on purpose and the stack order was overridden, so the state is
  stated rather than glossed: the worker context is a separate hidden renderer, **not** a
  sandboxed one, and it has no more isolation than a panel iframe ever had
  (`docs/LIMITATIONS.md` §Security). What it does not have is a privileged channel either — it
  reaches the host through the same validated `RUNTIME_REGISTER`/`RUNTIME_DELIVER` path a panel
  uses. Content-script injection is still held until sandbox lands.
