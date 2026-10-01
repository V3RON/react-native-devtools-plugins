# Small shims (Tier 2 one-offs)

| | |
| --- | --- |
| **Status** | 🟨 `chrome.action` + `chrome.notifications` exist as registrable **no-op shells** so a worker can load; nothing implemented for real |
| **Tier** | 2 |
| **Blocked by** | [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (messaging router + contract rules apply to all of these) |

Cheap, independent wins. All must follow the house rules from
[RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (promise+callback, `lastError`, real Event
objects) and the stubbing rule of thumb from [../OVERVIEW.md](../OVERVIEW.md).

**What already exists, and exactly what is still owed.** The background context arrived before
these APIs did, and an MV3 worker that names `chrome.action.onClicked` or
`chrome.notifications.create` at module scope dies at LOAD — an ESM worker's top-level
statements run before anything can guard them. So `src/chrome-shim/browser-apis.js` ships both
as inert shells, marked `[STUB — issue #4 owns making this real]`. Each of these is a real
behavior that does not exist and must be built, not discovered:

| Shell | What it does today | What it must do |
| --- | --- | --- |
| `action.onClicked` | registrable, **never fires** | needs a tab/target model to hand the listener |
| `action.setIcon` / `setBadgeText` / `setBadgeBackgroundColor` / `setBadgeTextColor` / `setTitle` / `setPopup` / `getPopup` / `enable` / `disable` / `create` | accept the call, resolve `undefined`/`""`, render nothing | a toolbar surface, or an explicit "no toolbar here" decision |
| `notifications.create` | shows nothing, calls back with **no id** (an id for a notification that does not exist would be a promise of a click that never comes) + one console line | Electron `Notification`, and the id Chrome allocates |
| `notifications.update` / `clear` / `getAll` | `false` / `false` / `{}` | real registry |
| `notifications.onClicked` / `onClosed` / `onButtonClicked` | registrable, **never fire** | fire from the real notification |
| `notifications.getPermissionLevel` | answers `"granted"` (so an extension does not go ask the user for a permission this host would then have to honor) | the real system state |
| `notifications.PermissionLevel` | Chrome's constants, including its `unspecifed` typo | — |

`notifications` is permission-gated like Chrome's (an extension that does not declare the
permission gets `lastError`, not a silent no-op — asserted); `action` needs no permission in
Chrome and stays ungated here.

## `chrome.permissions`

**✅ Real as a report, accept-and-grant as a promise** (`src/chrome-shim/permissions-api.js`).

| Method | Status |
| --- | --- |
| `contains` / `getAll` | **real** — exactly the permissions the manifest declares, from the HOST's verdict (`RUNTIME_REGISTER` read the manifest from disk), not from `runtime.getManifest()` a page can overwrite. An undeclared permission reports `false`, so this is safe to sit in front of feature-detection code rather than switch it on. |
| `request` | **accept-and-grant** — resolves `true` when everything requested is already declared (Chrome's own no-prompt fast path) and `false` otherwise, with one console line. See the divergence below. |
| `remove` | resolves, changes nothing — Chrome cannot remove a required permission either, and fires `onRemoved` for neither. |
| `onAdded` / `onRemoved` | registrable, **never fire** — nothing here changes a grant, so there is no transition to report. |
| `host_permissions` | absent from every answer, like `src/shared/permissions.js`: they buy network reach, not API access. |

**The divergence, stated plainly:** this shell cannot *grant* anything a manifest did
not declare, because permission enforcement (issue #10) decides capability from the
manifest **on disk** — `src/main/delivery-scope.js` in main and
`src/chrome-shim/permission-gate.js` in the frame. `request` accepting a call is shape
fidelity, not new capability. Answering `true` for an undeclared permission would be
worse than answering `false`: the extension would proceed and be refused at the first
real call, with `lastError` naming a permission it was just told it held.

## `chrome.tabs` / `chrome.windows` (subset)

**🟨 One synthetic tab = the inspected RN target, plus what `create` really opened**
(`src/chrome-shim/tabs.js` + `tab-model.js`, host side `src/main/tab-host.js`).

| Method | Status |
| --- | --- |
| `query` / `get` / `update` / `getCurrent` | **real for one tab** — all four answer with the SAME tab, read live from the host each time. `id` is the number `chrome.devtools.inspectedWindow.tabId` reports, so both APIs talk about one thing. `url`/`title` come from `Target.getTargetInfo` while the CDP bridge is attached (or from the bridge's own target record if the method is refused). |
| no-session fallback | **documented constants, not a guess** — url `about:blank`, title `""`, and `status`/`windowId` are ABSENT rather than filled in: there is no loaded document and no window to be in. |
| `create({url})` | **real descriptor, policy-driven side effect** — returns an `id` and a resolved url (a bare path resolves against the extension origin, which is what Altair's `o.url.includes(id)` check needs), fires `onCreated`, and adds one non-Chrome field: `openedVia` = `"external"` / `"window"` / `null`, saying what actually opened. |
| `remove` | closes what `create` opened (by the host's own handle), fires `onRemoved`; for the inspected id it is a **resolving no-op** with one console line; an unknown id fails with Chrome's `No tab with id: N.` |
| `update({url})` | reports that navigation is impossible and answers with the unchanged tab. `update({active: true})` does **not** fire `onActivated` — nothing changed, so there is nothing to announce. |
| `sendMessage` | **still inert, deliberately** — resolves `undefined` with one console line and is *not* routed into this extension's own runtime mesh. See below. |
| `captureVisibleTab` | `undefined` — a PNG-shaped string would be a fabricated screenshot. |
| `onUpdated` / `onActivated` / `onHighlighted` / `onMoved` / `onAttached` / `onDetached` | registrable, **never fire**: no navigation, activation, move or attach can happen to a one-tab model. |
| `query` filters | answered where honest: `active`, `currentWindow`/`lastFocusedWindow`/`lastOpenedWindow` (the inspected tab is the one tab of the one window), `status`, and `url` through **the same match-pattern compiler `chrome.webRequest` uses**. `windowId` / `groupId` / `title` match nothing — answering "yes" would claim a window model this shell does not have. |

**`tabs.create`'s external open is a policy, and the default is off.** `shell.openExternal`
is Chrome's closest mapping and it is wired end to end (`TABS_OPEN` →
`src/main/tab-host.js`), injectable at every layer. It defaults to **`none`**
(`DEVTOOLS_TABS_OPEN=none|external|window`) because both shipped extensions call
`create` from an *automated* path, not a user gesture: graphql's `runtime.onInstalled`
opens a marketing URL and Altair opens one from `notifications.onClicked`. Launching the
user's real browser because a devtools session started — or because a notification they
never clicked was created — is a side effect no extension asked this host for, and the
user cannot take it back. Whichever policy is set, the Tab descriptor says what really
happened, so nothing is claimed that did not occur.

**`tabs.sendMessage` is not wired to the extension's own messaging, on purpose.** There is
no content-script context to deliver to ([CONTENT-SCRIPTS.md](CONTENT-SCRIPTS.md) is the
next layer, issue #5). Routing it through `runtime.sendMessage` would let an extension
message *itself* and read the success as a page having answered — exactly the false
positive a devtools extension would then trust. So it resolves `undefined`, once per
context with the reason in the console. Chrome's own answer here is a connection error;
that difference is a stated deviation rather than a claim of success.

## `chrome.notifications`

→ Electron `Notification`. Genuinely useful (build finished, error alerts).

## `chrome.alarms`

`create/update/clear/getAll/onAlarm` → `setTimeout`/`setInterval` inside the
[background worker](BACKGROUND-WORKER.md) context.

## `chrome.downloads`

`download({url | data})` → Electron save dialog + fs. Shares plumbing with
`InspectorFrontendHost.save` (see [../api/INSPECTOR-FRONTEND-HOST.md](../api/INSPECTOR-FRONTEND-HOST.md)).

## `chrome.action` / `commands` / `contextMenus` (browser-side)

Accept-and-no-op shells with the full method shape (`setIcon`/`setTitle`/`onClicked`,
`onCommand`, `create/update/remove`…). No toolbar/right-click exists; they must not throw.

## Manifest `options_ui`

`runtime.openOptionsPage()` → open the options HTML in a separate Electron window using
the `rozenite://` protocol.

## `panels.elements` / `panels.sources` / `panels.performance`

Covered in [DEVTOOLS-PANELS.md](DEVTOOLS-PANELS.md); listed here only to complete the
Tier-2 inventory: all remain ❌ and depend on
[INSPECTED-WINDOW.md](INSPECTED-WINDOW.md) / frontend events.
