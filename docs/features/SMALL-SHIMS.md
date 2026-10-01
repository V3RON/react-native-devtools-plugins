# Small shims (Tier 2 one-offs)

| | |
| --- | --- |
| **Status** | 🟨 `permissions`, `tabs` (one synthetic tab) and `notifications` are implemented; `alarms`, `downloads` + `options_ui` and the `action`/`commands`/`contextMenus`/`sidePanel` shells follow below |
| **Tier** | 2 |
| **Blocked by** | [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (messaging router + contract rules apply to all of these) |

Cheap, independent wins. All follow the house rules from
[RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (promise+callback, `lastError`, real Event
objects) and the stubbing rule of thumb from [../OVERVIEW.md](../OVERVIEW.md).

**The rule these all follow.** Tier-2 APIs that answer "nothing" are worse than absent,
because an extension's feature-detection branch lights up and then fails on the first real
call. So each one gets either a real Electron-backed behavior, or an honest accept-and-grant
shell whose divergence is written down here rather than discovered by a user. Inventing a
value, an event, or a capability is not an option in either branch.

**Where each one started.** The background context arrived before these APIs did, and an MV3
worker that names `chrome.action.onClicked` or `chrome.notifications.create` at module scope
dies at LOAD — an ESM worker's top-level statements run before anything can guard them. So
`src/chrome-shim/browser-apis.js` shipped both as inert shells. `notifications` is real now;
`action` is the one that is left, for a reason stated below.

| Shell | Status |
| --- | --- |
| `action.onClicked` | registrable, **never fires** — Chrome hands that listener a Tab, and the one tab this shell has is the inspected RN target, which has no toolbar button to click. Needs a toolbar surface, or an explicit "no toolbar here" decision. |
| `action.setIcon` / `setBadgeText` / `setBadgeBackgroundColor` / `setBadgeTextColor` / `setTitle` / `setPopup` / `getPopup` / `enable` / `disable` / `create` | accept the call, resolve `undefined`/`""`, render nothing — the shell's whole job is that a worker can LOAD |
| `notifications.create` | **real** — Electron `Notification`, and the id Chrome allocates (see the table below) |
| `notifications.update` / `clear` / `getAll` | **real registry** |
| `notifications.onClicked` / `onClosed` | **real**, from the notification's own callbacks; `onButtonClicked` never fires |
| `notifications.getPermissionLevel` | reports what the host can observe (`Notification.isSupported()`) |
| `notifications.PermissionLevel` | Chrome's constants, including its `unspecifed` typo |

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

**🟨 Real system notifications, with three things it will not do**
(`src/chrome-shim/browser-apis.js` + host side `src/main/notification-host.js`).

| Method / event | Status |
| --- | --- |
| `create` | **real** — shows an Electron `Notification` and the callback receives the id that was allocated. If nothing could be shown, **no id is named** and the platform's reason is logged once. |
| `update` | resolves `true` for an id that is really on screen and `false` otherwise, plus one line: a notification already showing cannot be rewritten through Electron. |
| `clear` / `getAll` | **real registry** — `clear` answers whether this context knew that id, fires `onClosed` like Chrome does, and `getAll` returns the options of what is actually still up. |
| `onClicked` / `onClosed` | **real, and never fabricated** — fired only from the notification backend's own click/close callbacks, delivered into the context that created the notification. |
| `getPermissionLevel` | reports what this host can **observe** (`Notification.isSupported()`), not a verdict from a prompt that does not exist here. |
| `onButtonClicked` / `onShowSettings` | registrable, **never fire** — Electron's `Notification` has no button callbacks and no settings affordance. A `buttons` array is reported as ignored rather than dropped in silence. |
| `setPermissionLevel` | removed from Chrome in 42; kept registrable because real manifests still call it. |
| `PermissionLevel` | Chrome's constants, including its `unspecifed` typo, which extensions compare on. |

Gated on the declared `notifications` permission like Chrome's — Altair declares it,
graphql and the sample extension do not, and an extension that does not gets
`runtime.lastError` rather than a silent no-op. The permission is enforced **twice**: the
frame's gate, and `src/main/ipc.js` from the host's own grants, so a frame that ignored
its `RUNTIME_REGISTER` reply cannot raise a notification either.

**Three things this will not do, on purpose:**

1. **It never invents an id.** An id is the promise of a click. If the platform refused,
   `create` resolves `undefined`.
2. **It never invents a click.** Altair's `onClicked` listener opens a changelog URL, so
   firing that event without the OS having observed a click would launch something the
   user never asked for. `onClicked` has exactly one producer: the backend's click
   callback.
3. **A notification belongs to the context that created it.** Chrome delivers the click
   there, and so does this shell — via `src/main/context-registry.js`, which holds the
   same `send` closure the message router uses and is keyed by the frame identity main
   derived. The message router (fan-out to every frame of the extension) is the wrong
   tool and is not used.

**Electron 38 has no `Notification.close()`.** `clear` therefore removes the id from the
host's ownership and stops forwarding that notification's events; the banner stays on
screen until the user or the OS dismisses it. That is recorded in
[../LIMITATIONS.md](../LIMITATIONS.md) rather than presented as a real dismiss.

## `chrome.alarms`

**✅ Real timers, one divergence** (`src/chrome-shim/alarms.js`, GitHub issue #4).

| Method | Status |
| --- | --- |
| `create(name, alarmInfo)` | **real** — a timer in the extension's own context. `when` (epoch ms), `delayInMinutes`, `periodInMinutes`, and Chrome's argument rules are enforced **synchronously**: `delayInMinutes` + `periodInMinutes` together, an empty `alarmInfo`, and a delay/period under Chrome's 30 s floor each throw a `TypeError`, in callback style too — an extension that typos the field and gets a silent async rejection schedules nothing and never learns. |
| `clear` / `clearAll` | **real** — resolve the honest boolean / count of what was actually armed. |
| `get` / `getAll` | **real** — `{name, scheduledTime, periodInMinutes?}` for what is armed now; a one-shot alarm has no `periodInMinutes` key at all, like Chrome's. |
| `onAlarm` | **real** — fires with the time the occurrence was **SCHEDULED for**, not the tick's clock time, so an extension can tell a late delivery from an on-time one. A periodic alarm's next occurrence is anchored on the schedule, so a late tick does not push the series back. |
| re-`create` with the same name | **real replace** — the old timer is cancelled, so the replaced schedule cannot fire. |

Gated on the declared `alarms` permission, like Chrome's (`API_PERMISSIONS` already listed
it; the gate is asserted).

**The divergence: alarms do not outlive the context.** Chrome persists alarms and wakes the
service worker to fire them. This host's background context is **always-on**
([BACKGROUND-WORKER.md](BACKGROUND-WORKER.md)) — nothing evicts it, so there is nothing to
wake — and nothing here persists an alarm, because claiming persistence without a store
would be a fabrication. Consequences worth stating: an alarm dies with the window that
created it (the preload cancels every alarm on `pagehide`, and the test for that is the one
named "nothing may fire after the worker is gone"), and an alarm does not survive a shell
restart.

**The clock scale.** A headless test cannot wait 30 seconds for Chrome's own minimum alarm
delay, and faking the shim's clock *inside* the extension context would prove nothing about
the path this shell uses. So the host offers a multiplier —
`DEVTOOLS_ALARM_CLOCK_SCALE` (`src/main/config.js`) — decided in **main** and handed to each
context in its `RUNTIME_REGISTER` reply, so a page-world script can neither see nor influence
it. It shortens the wait only: validation still uses Chrome's real floors and `scheduledTime`
still reports the real scheduled time, so a scaled run is not a loosened one. The unit tests
above inject their own timers and need neither.

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
