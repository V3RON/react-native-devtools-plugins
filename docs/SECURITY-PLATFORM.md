# Security platform: threat model, filesystem/code-execution audit, target architecture

Status: audit + design, 2026-10-14. Changes no code and no status mark elsewhere. A separate
cost-ranked advisory (pricing, risk-per-day ranking) is meant to be folded into this doc later.
That is why every recommendation here is a **costed option with a stance** (worth doing /
defer / do not do), not a required stage.

**The maintainer's line**, which this doc is written to: a developer who installs a plugin
accepts that it may misbehave *within its own remit*. What it must never hold is **ambient
authority it was not granted**:

- (a) the DevTools frontend's privileged channels;
- (b) the user's filesystem beyond what a declared permission plus an explicit user action
  earned.

When a fix is too expensive or impossible, we live with the gap and say so in
[§7](#7-what-we-consciously-accept).

### Evidence labels (house rule: unrun = unverified)

| Label | Meaning |
| --- | --- |
| **[measured]** | I ran it for this audit (bare Node against `src/` with real `fs` in a temp dir, or a standalone Electron **38.0.0** probe borrowed from the main checkout's `node_modules`, run headless). The probe scripts lived in `/tmp` and are not committed; §5 names the test each one becomes. |
| **[test]** | Asserted by an existing test in `tests/`. Not re-run here: `node_modules` is not installed in this worktree, so `npm test` cannot run. |
| **[code]** | Read from the code at the cited line, not executed. |
| **[docs]** | Stated by a doc (this repo's or Chrome/Electron's), not checked. |
| **[inferred]** | Reasoned from the above; needs a measurement before anyone relies on it. |

---

## 1. Findings first

### 1.1 The short answer

**Two filesystem gaps were reachable from ordinary extension code.** Both crossed line (b),
and both were cheap to close. **F2 — the delete and the overwrite — is closed (issue #22)**,
which is line (b)'s write side. **No route from extension page code to Node was found.**

> One correction the reader needs before trusting F1's row below: it still says the read gap is
> open, and that is stale. The guard it asks for exists (`resolveInsideExtension`,
> `src/main/extension-server.js`, on `fs.realpath`) and is tested
> (`tests/extension-symlink-containment.test.js`); the prose recording it was closed was dropped
> when `sec/issue-21-symlink-read` was merged into the stack (`72e04ff`), whose conflict
> resolution took the older file for `docs/SECURITY-PLATFORM.md`. It needs re-landing on that
> link, so it is called out here rather than rewritten from this one.

| # | Finding | Line | Evidence | Fix (estimate) |
| --- | --- | --- | --- | --- |
| F1 | `rozenite://` containment is checked on the path string only, not on the resolved path. A symlink inside an extension folder is followed. | (b) read | [measured] | ~6 lines |
| F2 | A failed or cancelled `chrome.downloads.download` removed the target path, even when that file existed before, and a write onto an existing name silently overwrote it or followed a symlink standing there. **Fixed (issue #22):** the bytes are staged in a `.rozenite-partial` file the download creates with an exclusive create and renamed onto the final name only on success, so the only unlink this service can issue is on its own partial file; the default conflict action is Chrome's `uniquify` (`name (1).ext`), `overwrite` is honored only when the caller asks by name, and a symlink at the target is refused rather than followed. | (b) delete | was [measured] delete-after-fetch-failure, silent overwrite, symlink followed; closed by [test: `tests/save-service.test.js` (including the two against a real disk), `tests/host-primitives.test.js`, `tests/tier2-worker-electron.test.js` (the real-process save)] | ~30 lines — **done** |

Three more findings are ambient authority rather than filesystem. They are listed here because
they are equally cheap:

| # | Finding | Line | Evidence | Fix (estimate) |
| --- | --- | --- | --- | --- |
| F3 | The CDP bridge's WebSocket listened on every interface, accepted any `Origin`, and "last connection wins". Any local web page or LAN peer could replace the frontend's debugger session, and upstream it was presented to Metro with a loopback `Origin`. **Fixed (issue #23):** the default bind is the two loopbacks, `verifyClient` accepts only the frontend's origin (plus `DEVTOOLS_CDP_ALLOWED_ORIGINS`) or an Origin-less dial from a loopback peer, and a second client is *refused* rather than evicting the owner. | debugger session / the app | was [measured] bind address, foreign `Origin` accepted, frontend evicted; closed by [test: `tests/cdp-bridge.test.js`] | ~10 lines — **done** |
| F4 | An extension's own top-level window (background worker, options page) has no navigation guard and no window-open handler. A navigated-away document receives the **frontend** preload (`src/preload/index.js:16-20`). Its `PREF_*`, `WINDOW_*` and `SHOW_CONTEXT_MENU` are not gated in main (the `ipcMain.handle(PREF_*/WINDOW_*/SHOW_CONTEXT_MENU)` block in `src/main/ipc.js`, above `RUNTIME_GET_MANIFEST`). | (a) | [measured] in a standalone probe that mirrors the preload dispatch; the production path is [code] | ~15 lines |
| F5 | `chrome.devtools.*` is installed in **every** extension context (`src/chrome-shim/index.js:224-236`). Main gates `DEVTOOLS_EVAL` / `DEVTOOLS_RELOAD` / `NETWORK_GET_BODY` only on "is a registered frame" (the `ipcMain.handle(DEVTOOLS_EVAL)` … `ipcMain.handle(NETWORK_GET_BODY)` range in `src/main/ipc.js`; the shared rule is `resolveFrameKey`). So an always-on worker, an options page, or an extension with no `devtools_page` can evaluate JS in the app and read response bodies. Chrome limits these APIs to DevTools contexts [docs]. | app / network data | [code] | ~15 lines |
| F6 | **Found after the audit** (issue #20): the delivery-scope filter `ipc.js` applies to every host→frame network push was **never imported**. Its `ReferenceError` was thrown inside `network-service.js`'s `broadcast`, which wraps each `send` in `try { … } catch {}` and swallows it, so **every live `webRequest` / `devtools.network` push was dropped for every frame with no log line** — while `getHAR` / `getContent` kept working and hid it. The "enforced twice" claim in [LIMITATIONS.md](LIMITATIONS.md) was, for the main-process half, "enforced by crashing". One import; the gap that let it ship was the missing live-push test. | feature loss, and a guard that read as present | [test: `tests/delivery-scope.test.js` — measured to fail both ways: with the import removed, and with the filter replaced by `() => true`] | 1 line + 1 test file |

**F6 is the audit's own failure mode, made concrete.** §5 lists
`tests/delivery-scope.test.js` as the S2 safety net; that file did not exist, and every
document citing the filter cited it. A filter no one pushes anything through is a claim in a
doc, and `catch {}` in a notification fan-out turns its absence into silence. The lesson
recorded here: a guard whose only evidence is a unit test of the *pure function* is not a
guard — something has to observe the value arriving.

**F6 — `tabs.create` under `DEVTOOLS_TABS_OPEN=window` loaded any scheme, and is fixed.**
Crosses line (b) like F1 and F2, but needs the non-default policy, so it is listed apart from
both tables above. The `window` branch of `tab-host.js` called `win.loadURL(url)` with no
scheme filter while its sibling `external` branch filtered through `openableUrl`, so
`create({url: "file:///Users/me/Downloads/x.html"})` put a page under the `file://` origin in
a shell window — chained with a download that leaves a file in `~/Downloads` and
`downloads.search`'s absolute path, that is a read of anything that origin can fetch. The
chain itself is [inferred]; the missing filter was [code].

Fixed at the policy boundary: `openableWindowUrl` (`src/main/tab-host.js`) applies the same
`openableUrl` the external branch applies, before a window is created, and additionally allows
`rozenite://<id>/…` — this shell's own protocol, which is what `create` of a relative path
resolves to, so an extension opening its own page still works. A refused URL throws the same
message either policy gives, so the frame's shim reports one shape for "nothing opened"
regardless of which policy is set. Asserted in `tests/tabs.test.js` and, through the real
`attachTabHost` wiring, in `tests/frontend-host-electron.test.js`. What this does **not** do is
guard the window it opens — the `tabs.create` `window`-policy window, now named in F4's `L4` row
alongside the worker and options windows — no navigation guard, no `setWindowOpenHandler`. That
is `L4`, not this fix.

### 1.2 What is NOT there (also the answer)

- **No route from extension page code to Node.** The page world has no `require` / `process` /
  `Buffer` / `ipcRenderer` [test: `tests/extension-frame-electron.test.js`]. The preload exposes
  named `invoke` wrappers only (`src/preload/extension-frame.js:22-352`) [code]. The repo has no
  `new Function` and no `sendSync` channel of its own (§3.6 has the one dependency exception)
  [code + test: `tests/security.test.js`].
- **No write outside `~/Downloads` or a path the user picked in a dialog.** `safeName` drops
  every directory component [measured, §3.3]. `fixedPath` is reachable only from the frontend
  [code, §3.3]. And since issue #22 the stronger version holds on the write side too: a save
  creates a new file, or goes where the user pointed a dialog, or is refused. It cannot modify
  or delete a pre-existing file *without consent*: no failure — a 404, a bad `data:`, a full
  disk, a cancel — can reach one, because the bytes are staged in the download's own partial
  file and the final name appears only through `rename` on success; a taken name is uniquified
  rather than overwritten; and a symlink at the target is refused instead of followed. The one
  replacement that remains is a path the user aimed the dialog at (or the remembered path that
  dialog produced), which is consent itself — and even that one leaves the earlier bytes intact
  if the save fails [test: `tests/save-service.test.js`, the F2 cases against the real `fs`;
  `tests/host-primitives.test.js`].
- **No path traversal through `rozenite://`.** `../` and `?script=../` both return 404
  [test: `tests/background-worker-electron.test.js:604-677`]. F1 is the symlink case, which
  that guard never covered.
- **The frontend's file channels are refused to every extension context.** `HOST_SAVE`,
  `HOST_APPEND`, `HOST_CLOSE_FILE`, `HOST_OPEN_EXTERNAL` and `HOST_CONFIG` are gated by
  `isFrontendFrame` (the `ipcMain.handle(HOST_*)` block at the end of `src/main/ipc.js`,
  `src/main/frontend-frame.js:50-57`) [code].
  This holds even in F4's navigated window, which is not the frontend's WebContents.

### 1.3 The eight pre-verified facts, confirmed or corrected

| # | Claim | Verdict |
| --- | --- | --- |
| 1 | IPC is an allowlist of named channels with frame-derived identity, not "full filesystem via IPC" | **Confirmed** for extension frames. Two corrections. The filesystem gap that exists runs through the **protocol** (F1), not IPC. An extension's own *window* can reach the frontend preload by navigating away (F4). |
| 2 | `HOST_*` file channels are `isFrontendFrame`-gated; `DOWNLOAD_*` use `gatedFrameKey(event, "downloads")`; permissions are enforced twice | **Confirmed** (the `ipcMain.handle(DOWNLOAD_*)` block and the `ipcMain.handle(HOST_*)` block in `ipc.js`). Not gated: the frontend preload's other channels — `PREF_REGISTER/GET/GET_ALL/SET/REMOVE/CLEAR`, `WINDOW_BRING_TO_FRONT`, `WINDOW_CLOSE`, `SHOW_CONTEXT_MENU` (the `ipcMain.handle(PREF_*/WINDOW_*/SHOW_CONTEXT_MENU)` block in `ipc.js`). |
| 3 | `safeName()` strips directories, so downloads cannot leave the chosen directory | **Confirmed** [measured]. `..` and `.` survive as whole names; the write then failed with `EISDIR`, which was harmless only by accident — under the fix they are refused as names (`isWholeDot`) so nothing is created beside them. The symlink that **already exists** at the target name **is no longer followed**: it is refused (issue #22) [test: `tests/save-service.test.js`]. |
| 4 | Download without `saveAs` writes with no prompt; the realistic abuse is silent overwrite, which is Chrome's behavior | **No prompt: confirmed.** **"Chrome's behavior": corrected, and now matched.** Chrome's default `conflictAction` is `uniquify`; it overwrites only when the call passes `overwrite` [docs: Chrome]. The shell now defaults to `uniquify` as well, and `overwrite` is honored only when a caller asks for it by name (issue #22). **The realistic abuse was worse than overwrite — it was delete (F2)** — and that is closed with it. Also, the shim still compares against `"unique"` (`src/chrome-shim/downloads.js`), but Chrome's value is `"uniquify"`: issue #27. |
| 5 | `rozenite://` has no per-extension origin isolation; the fix may be a few lines in the handler | **Corrected.** Origins *are* distinct: cross-extension DOM access throws `SecurityError` [measured]. What is missing is a CORS check on the custom-scheme loader: even a `no-cors` fetch comes back `basic` with a readable body [measured]. **The fix cannot live in `protocol.handle`:** its `Request` carries no `Origin` and an empty `referrer` [measured]. `session.webRequest.onBeforeRequest` *does* fire for the scheme, with `details.frame.url` naming the requester [measured]. That fix is ~30 lines (§4, L6). The comment at `src/main/frame-security.js:62-65` ("shares one origin") is wrong. `:33-35` says the scheme is registered `secure`, but the code (`extension-server.js:110`) does not register it so. |
| 6 | `sandbox:false` ⇒ renderer compromise = Node compromise; `nodeIntegrationInSubFrames` is load-bearing | **Confirmed, crux below.** Measured on Electron 38: with `sandbox:true` + `nodeIntegrationInSubFrames:true`, the preload still runs in `rozenite://` iframes (`process.sandboxed === true`). Its `require` resolves `electron` / `events` / `timers` / `url` only; `fs`, `path` and `./local` fail. With the flag false, no iframe preload runs at all. So under sandbox the flag **stays true**; it is the "run preloads in subframes" switch. |
| 7 | `host_permissions` excluded from the gate; `permissions.request` grants nothing | **Confirmed.** `host_permissions` guards no capability here, in either direction. It does not limit egress, and the scheme is not `corsEnabled`, so it does not grant Chrome's CORS exemption either [inferred, unmeasured]. It is theater. §4 L10 says not to make it real. |
| 8 | "Installed" = a folder in `extensions/`, with no signature, review, or lifecycle UI | **Confirmed.** Minor addition: `extensions.js:16-17,37` uses `Dirent.isDirectory()`, so a *symlinked* extension folder is not scanned, yet the file server would still serve it [code]. |

**The sandbox crux, unhedged.** `sandbox:true` does **nothing** against ordinary extension code
that follows the API. That code already cannot reach Node (fact 6, [test]). Sandbox contains
exactly one thing: a **Chromium renderer exploit** (a V8/Blink bug, n-day or 0-day) shipped
inside a plugin. Without sandbox, that exploit is user-level code execution on the machine.
With it, the attacker also needs an OS sandbox escape. That makes it **insurance priced at a
build step**, not a requirement. Per the maintainer's own framing it ranks below F1–F5, which
are reachable by plain JavaScript.

---

## 2. Trust model and threat actors

The asset being protected is **the developer's machine**: files, other apps' data, and the
DevTools session. The developer's RN app is a second asset, and also a *victim* of code the
developer opted into.

| Actor | Allowed (consented remit) | Must never hold | Open gaps |
| --- | --- | --- | --- |
| Store extension of unknown intent | Its own pages, storage, declared APIs; `eval` into the app from DevTools contexts (Chrome grants this to any devtools extension) | Frontend channels; files outside its folder; deleting user files | F1 (see the note in §1.1), F4, F5. F2 — deleting user files — is closed |
| Folder the developer dropped in (today's only install path) | Same as above; semi-trusted by the act of installing | Same | Same; no consent prompt or integrity check (accepted, §7) |
| Legit extension with a bug | Same | Same; a bug must not become data loss | None on the filesystem: a buggy download can now fail all it likes and the user's files are what they were (F2 closed, issue #22) |
| Rogue Metro / patched frontend fork over `http://127.0.0.1:8081` | It **is** the frontend (`isFrontendFrame` is an origin check). Saves stay dialog-gated; `openInNewTab` is http(s) only. It already serves the app's JS, so it owns the app. | Node; silent file writes | None found beyond §7 (renderer exploit) |
| Peer on the CDP socket (another local process, a browser page, a LAN host) | Nothing; only the frontend should connect | The app's debugger session | F3 |
| The developer's RN app, as a victim | Content scripts run in its JS realm only when `DEVTOOLS_CONTENT_SCRIPTS` names the extension | Script injected without that opt-in | F5 (`eval` from non-DevTools contexts). Inside the opted-in realm there is no isolated world, and content-script identity is the payload's `envelope.x` (`src/main/content-bridge.js:987`). Accepted, §7. |

---

## 3. Filesystem and code-execution audit

### 3.1 Every host-side write, truncate and delete, and who can reach it

| Operation | Where | Reachable from | Who picks the path | Verdict |
| --- | --- | --- | --- | --- |
| `writeFile` (`wx`, into a `.rozenite-partial` beside the target) | `save-service.js` (`start`, staging step; attached in `attachSaveService`) | extension with `downloads` (`ipcMain.handle(DOWNLOAD_START)` in `ipc.js`); frontend (`HOST_SAVE`) | non-`saveAs`: `~/Downloads/<safeName>`; `saveAs`: the user's dialog; `fixedPath`: host-files only | Stays in `~/Downloads` top level. **It can no longer write to a name the service does not own:** the create is exclusive, so an existing file — or a symlink — is refused rather than overwritten or followed. The final name appears only through the `rename` row below. |
| `rename` (partial → final name) | `save-service.js` (`resolvePartial` → `rename`, on success only) | same | the name `resolveTarget` chose: uniquified against the directory on the no-prompt path, verbatim for a dialog choice and for `fixedPath` | The only operation that can create the final name, and it runs after every way the download can still fail. On the no-prompt path a taken name was already uniquified; on a dialog path the replace is the consent, and it is still atomic. `rename(2)` would replace a symlink rather than write through one, but the symlink is refused up front so this never comes up. |
| `unlink` via `removePartial` | `save-service.js`, called only on the staged partial | same | the partial path this download created and claimed | **Was F2.** Now it can only ever be handed `staged` — a name probed free, then created by this call — and the final name is never a candidate. Closed by [test: `tests/save-service.test.js`, the F2 cases] |
| `appendFile` | `host-files.js:107` (attached `:135`) | frontend only (`HOST_APPEND`, `isFrontendFrame`) | only a path a completed save of that url produced (`:100-105`) | Sound |
| Re-save to remembered path | `host-files.js` (`save`) → `fixedPath` (`save-service.js`) | frontend only | the remembered path | Replaced on success, and that is what a re-save means; it can no longer damage the earlier file, because the new bytes arrive in a partial and are renamed only on success (issue #22). A failed re-save — mid-write, or a symlink at the remembered path — leaves the earlier contents intact [test: `tests/host-primitives.test.js`]. `savedURL` identity survives because `fixedPath` deliberately does *not* uniquify. |
| `chrome.storage` persistence | `storage-service.js:355-361` (electron-store under `userData`) | extension with `storage` | `extension-<id>-<area>`; id matches `^[A-Za-z0-9._-]+$` (`extension-server.js:31`); area is validated (`storage-service.js:244`) | Sound; quota-bounded (`storage-core.js:17-28`) |
| Frontend preferences | `preferences.js` (electron-store) | `PREF_SET/REMOVE/CLEAR`, **ungated** | fixed store | Not a filesystem escape, but F4 lets a navigated extension window write it |
| Install state | `install-state.js` | host only | fixed | Sound |
| Test-seam log append | `external-open.js:72-75` | frontend `openInNewTab`, only when `DEVTOOLS_TEST_OPEN_LOG` is set | the environment | Sound (§3.5) |

### 3.2 Host-side reads an extension can trigger

| Read | Where | Path source | Verdict |
| --- | --- | --- | --- |
| `rozenite://<id>/<path>` file | `extension-server.js:273-307` → `resolveExtensionFile` `:72-78` → `resolveInsideExtension` `:53-63` | URL | **F1**: `path.resolve` + prefix test, then `fs.statSync` / `net.fetch(file://)` follow links. Measured against the production module: a file link and a directory link inside the folder were both served from outside it. |
| Manifest, `_locales`, CSS localisation | `extension-server.js:125-151`, `:239-271`; `i18n-host.js` | fixed names under the root | Same resolver, so the same symlink exposure (JSON/CSS parsers limit what comes back) [inferred] |
| Bootstrap `?script=` | `extension-server.js:213-237` | query | Contained [test] |
| `chrome.downloads` source URL | `save-service.js:538-544` (`node-fetch` in **main**) | extension | Main fetches any http(s) URL with no CORS. The body goes to disk, not back to the extension. Only success/failure and the status text return. Comparable to Chrome's download fetch [inferred]. Accepted, §7. |
| Notification icon | `notification-host.js:60-77` | extension | `iconUrl` is passed but never loaded by the Electron notifier (`:157-170`) [code] |

### 3.3 `safeName`, `chooseTarget`, `fixedPath` (measured in bare Node against `src/main/save-service.js`)

- **`safeName`.** It keeps only the last path segment, split on `/` and `\`, then replaces
  `: < > | ? " * NUL`. Relative, absolute, Windows-style and percent-encoded names
  (`nameFromUrl` decodes first) all reduce to a bare name [measured; the basic cases are also
  in `tests/save-service.test.js`]. `.` and `..` survive as whole names. They used to fail the
  write with `EISDIR`, which was harmless *by accident*: once the conflict check uniquifies,
  the directory counts as a taken name and the shell would produce `. (1)` in the user's
  Downloads folder, so `resolveTarget` refuses a whole dot by name [test: `tests/save-service.test.js`].
  Files that merely *begin* with a dot (`.env`, `.gitignore`) are names and still save.
- **`chooseTarget`.** With `fixedPath` → that path. Without `saveAs` → `downloadsDir()/name`,
  **no prompt**, and since issue #22 that name is *checked*: `resolveTarget` lstats it and
  uniquifies to `name (1).ext` when it is taken, which is Chrome's default `conflictAction`.
  With `saveAs` → dialog (or the test seam), and the chosen path is used as given — the dialog
  is Chrome's conflict prompt. All three refuse a symlink at the name.
- **`fixedPath`.** It is set only from `request.filePath`. The `DOWNLOAD_START` handler builds
  its request field by field and never passes `filePath` (`ipcMain.handle(DOWNLOAD_START)`,
  which builds its request field by field in `ipc.js`), so only `host-files.js` can set it.
  It is the one path that does not uniquify, on purpose: `savedURL(url, path)` and every
  `append` that follows identify the frontend's file by that exact path. (The dialog's choice
  is likewise used as given; the difference is that a dialog asked a human, and a `fixedPath`
  did not — it just never needs a fresh name, because it *is* the name already agreed on.)
- **`data:` / `blob:`.** `data:` is decoded in main, and a malformed one throws — before the
  fix, *after* the target was chosen, which was one way into F2; now a throw at that point has
  no file of the user's to lose, because staging has not begun [test: the `data:`-URL case in
  `tests/save-service.test.js`]. There is no `blob:` path: a `blob:` URL from a renderer is not
  fetchable by `node-fetch` in main, so it fails, likewise harmlessly now [inferred].

### 3.4 F2, precisely — and what replaced it

`start()` assigned `record.filename = target.filePath` **before** producing the bytes. The
fetch, the `data:` decode, cancellation and the write itself could all fail after that point,
and every failure path then called `removePartial(record.filename)` — deleting a file the user
had put in their Downloads folder themselves, since the target was named by the extension or
derived from its URL. The write also truncated an existing file at that name, and followed a
symlink standing there, which is how a write left the directory.

Chrome avoids all three structurally: it stages the bytes and renames on completion [docs:
Chrome]. So does this shell now, in `save-service.js`:

1. `resolveTarget` picks the name — `lstat`ed (not `stat`ed) against the directory, uniquified
   on the no-prompt path, symlink refused, and **claimed before the look** so two downloads of
   one URL cannot resolve onto one name.
2. `resolvePartial` picks a `.rozenite-partial` name beside it the same way, stepping around a
   leftover from a crashed run rather than taking it over.
3. `writeFile` writes there with `flag: "wx"`, so the create is the kernel's own answer to "is
   this name free", not just the service's bookkeeping.
4. `rename` publishes it, only after every failure point has passed and only if a cancel has
   not arrived; `removePartial` then sees a path it created, or nothing at all.

The two sharp edges that shared this root cause went with it: the frontend's failed re-save no
longer eats the earlier file (§3.1), and `host-files.js`'s "known sharp edge" header now records
the rule instead of the hole.

`tests/save-service.test.js:272-278` used to *pin* the old behavior (it expected the target to be
unlinked). It is inverted: the same scenario asserts the partial is unlinked and that nothing
else in the directory can be.

### 3.5 Test seams

`DEVTOOLS_TEST_SAVE_DIALOG` and `DEVTOOLS_TEST_OPEN_LOG` are read once when `config.js` loads
(`:96-122`). They are ignored when `app.isPackaged`, and loud otherwise. The gate is airtight
for what it claims, with one caveat: **nothing is packaged today**, so every real run is
"unpackaged" and honours them. No extension-reachable channel sets the environment, and
anyone who can set it can already run code (`NODE_OPTIONS`). The seams are therefore not an
escalation [code].

### 3.6 Channel census: what an extension frame can call, and whether it can name a resource

Identity is always `event.senderFrame` / `event.frameId`, pinned to the principal registered at
`RUNTIME_REGISTER` (the `resolveFrameKey` helper and the `ipcMain.handle(RUNTIME_REGISTER)`
block in `ipc.js`) [code]. "Names" means a payload field the
host then acts on.

| Channel(s) | Gate in main | Payload can name | Verdict |
| --- | --- | --- | --- |
| `RUNTIME_GET_MANIFEST`, `RUNTIME_REGISTER` | frame URL host | nothing | Sound |
| `RUNTIME_SEND_MESSAGE/RESPONSE/CONNECT/PORT_*` | registered principal | port / request ids, router-scoped | Sound [test: messaging-frames] |
| `STORAGE_CALL` | principal + `storage` grant | area (validated), keys | Sound |
| `EXT_PANEL_CREATE` | principal; page must be a file of *this* extension (`ipcMain.handle(EXT_PANEL_CREATE)` in `ipc.js`) | page path inside own folder (guarded by realpath, see F1) | Sound |
| `DEVTOOLS_EVAL`, `DEVTOOLS_RELOAD` | principal **only** | expression / `injectedScript` (consented capability) | **F5**: no DevTools-context or `devtools_page` check |
| `NETWORK_SUBSCRIBE/GET_HAR/GET_STATUS/GET_BODY` | principal; `webRequest`-only kinds filtered (`delivery-scope.js`) | `requestId` | **F5** for bodies and HAR from non-DevTools contexts |
| `TABS_TARGET_INFO/OPEN/CLOSE/SEND_TO_APP` | principal + `tabs` | URL (policy `none` by default; `external` = http(s) allowlist; `window` = the same allowlist plus this shell's own `rozenite://<id>/`); window handle | Sound. Both open policies decide with `openableUrl` before anything opens, so `file:` and unknown schemes are refused under either (F6) [test: `tests/tabs.test.js`, `tests/frontend-host-electron.test.js`]. The window `window` creates still has no guards and gets Electron's default sandboxed, preload-less prefs — that half is F4/L4 [inferred] |
| `NOTIFICATION_*` | principal + `notifications` | id (owner from frame) | Sound |
| `DOWNLOAD_*` | principal + `downloads`; owner from frame | `url`, `filename` | **F2**; ledger scoped per extension |
| `OPTIONS_OPEN` | frame URL host; page contained | nothing | Sound; the opened window lacks guards (F4) |

Channels the extension preload does **not** expose, but which main also leaves ungated:
`PREF_*`, `WINDOW_BRING_TO_FRONT`, `WINDOW_CLOSE`, `SHOW_CONTEXT_MENU` (the
`ipcMain.handle(PREF_*/WINDOW_*/SHOW_CONTEXT_MENU)` block in `ipc.js`). The
same holds for electron-store's synchronous `electron-store-get-data`, registered by
`Store.initRenderer()` (`index.js:15`; electron-store 10.1.0 `index.js:25`). No renderer in
`src/` uses electron-store, so that call is dead code [code].

### 3.7 Routes to Node

From the **page world**: none (§1.2). From a **compromised renderer**: all of it, because
`sandbox:false` puts Node in every renderer that has the preload (`frame-security.js:70`).
That covers the frontend window, every worker window and every options window [docs:
LIMITATIONS; measured: `fs` / `path` / local `require` load in an unsandboxed preload].

---

## 4. Target architecture (keeps every feature)

Goal state, one sentence per asset:

- **Filesystem:** extension code can create *new* files in `~/Downloads` and write where the
  user picked in a dialog. It can read only its own folder, after symlink resolution. It can
  never modify or delete a file it did not create.
- **Frontend:** only the frontend window's main frame, on the frontend origin, reaches
  `InspectorFrontendHost` channels.
- **App:** only DevTools contexts of extensions declaring `devtools_page` may `eval` / read
  bodies. Content scripts stay opt-in.

| Layer | Design | Electron 38 primitives | Cost | Stance |
| --- | --- | --- | --- | --- |
| **L1 containment on resolved paths** | `resolveInsideExtension` also compares realpaths of target and root (see §6 step 1) | `fs.realpathSync` | ~6 lines | **Worth doing, first** |

| **L2 save broker invariant** | Write to a sibling temp file, then `rename`. Create the final name with exclusive-create (`wx`) and Chrome's ` (1)` uniquify on `EEXIST`. Cleanup only ever touches the temp file. `fixedPath` (frontend re-save) uses the same temp + rename. Do not implement `conflictAction:"overwrite"` for extensions (keep reporting it). Fix the `"unique"` → `"uniquify"` spelling. **Landed (issue #22)** with two deviations worth naming: the exclusive create is on the *partial* rather than the final name (the final name is created by `rename`, which is strictly stronger — the staging is `flag: "wx"`, and `resolvePartial` also lstats the candidate so a planted or leftover name is stepped around rather than unlinked), and `overwrite` is honored one layer down, in `createSaveService`'s `conflictAction` request field, while the shim still reports any `conflictAction` it does not accept and forwards nothing — which is exactly "keep reporting it," and is what issue #27 will wire. | `fs.promises.writeFile(…, { flag: "wx" })`, `rename`, `lstat` | ~30 lines + test edits | **DONE** (F2) |
| **L3 IPC broker** | Already in place: identity from frame, principal pinning, double permission enforcement, `isFrontendFrame` on file channels. **Add:** (i) `isFrontendFrame` on `PREF_*`, `WINDOW_*`, `SHOW_CONTEXT_MENU`; (ii) a `devtoolsCaller(event)` = registered principal **and** `event.sender === getFrontendContents()` **and** the manifest declares `devtools_page`, required by `DEVTOOLS_EVAL/RELOAD`, `NETWORK_GET_BODY`, and by `NETWORK_SUBSCRIBE/GET_HAR/GET_STATUS` unless the frame holds `webRequest`; (iii) delete the unused `Store.initRenderer()`. Keep the namespaces (shape-first rule); fail the call with lastError. | `ipcMain.handle`, `WebFrameMain` | ~25 lines | **Worth doing** |
| **L4 extension windows** | Worker, options, and `tabs.create`'s `window`-policy windows (the `Extension tab` `BrowserWindow` in `tab-host.js`'s `openWindow`): `setWindowOpenHandler(() => ({action: "deny"}))`, plus `will-navigate` / `will-redirect` allowing only `rozenite://<same id>/`. Reuse the `guardNavigation` shape from `frontend-frame.js:69-78`. Optional: route an http(s) link to `tabs-host` policy instead of dropping it. | `webContents.setWindowOpenHandler`, `will-navigate`, `will-redirect` | ~15 lines | **Worth doing** |
| **L5 CDP socket** | Default `listenHost` to loopback (`127.0.0.1` and `::1`, or switch the default `?ws=` to `127.0.0.1`). Add `verifyClient`: accept a missing `Origin` (non-browser local tools) or exactly the frontend's origin; reject everything else. `DEVTOOLS_CDP_HOST` stays the explicit opt-in for LAN use. **Landed (issue #23):** both loopbacks, `verifyClient` on the frontend origin + `DEVTOOLS_CDP_ALLOWED_ORIGINS` (unset by default), Origin-less accepted from a loopback peer only, and a second client refused instead of evicting the first. | `ws` `verifyClient`, `host` | ~10 lines | **DONE** (F3) |
| **L6 per-extension origin for reads** | `session.defaultSession.webRequest.onBeforeRequest({urls: ["rozenite://*/*"]})`: for non-navigation resource types whose `details.frame.url` is another extension's `rozenite://`, cancel unless the path matches the target's `web_accessible_resources`. Navigations and frontend-origin requests pass. Caveat: Electron keeps one `onBeforeRequest` listener per session, so a future user must share it. | `session.webRequest`, `details.frame` (both measured to fire for the scheme) | ~30 lines | **Defer**: cheap, but low value — it protects other extensions' bundled files, not the user's |

| **L7 sandbox + one bundled preload** | Bundle `src/preload/index.js` and everything it requires into one file (esbuild, CommonJS, `platform: "browser"`, `electron` external). Point `config.preloadPath` at it. Set `sandbox: true` in `basePreferences`, and then `app.enableSandbox()` so no future window forgets. `nodeIntegrationInSubFrames` **stays true** (measured: it is what runs the preload in iframes, sandboxed or not). The preloads only use `process.platform` / `arch` / `isMainFrame`, which a sandboxed `process` provides [docs: Electron; inferred for this code]. | `sandbox`, `app.enableSandbox()`, `contextBridge` | a build step: devDependency + script + tests built before they run; ~1–2 days [inferred] | **Insurance — defer, then do before shipping a packaged build** or before making content scripts manifest-driven (ROADMAP #3). It buys nothing against API-following code. |
| **L8 frame-class separation** (panels on their own `WebContentsView` / partition) | Would let frontend and extension pages have different prefs and sessions. But after L7 they need none, and it **breaks `Panel.onShown(window)`**: the devtools page reaches its panel through `window.open("", panelId)` in the same frame tree (`extension-frame.js:486-523`). It also means re-implementing tab layout as native overlays. | `WebContentsView`, `session.fromPartition` | a panel-hosting rewrite | **Do not do** |
| **L9 privilege separation for the background context** | It already has its own WebContents and renderer. After L3 it no longer holds DevTools authority, which is the separation that matters. A per-extension `persist:` partition for worker/options windows only isolates cookies and cache, which those windows do not use for anything privileged. `utilityProcess` is **wrong** for extension code: it is a Node process. | `session.fromPartition`; *not* `utilityProcess` | small (partition) | Partition: **defer**. utilityProcess: **do not do** |
| **L10 `host_permissions`** | Making it an egress allowlist (cancel http(s) from a `rozenite://<id>` frame outside the declared hosts) is leaky by construction: `downloads` fetches from main, and `eval` runs in the app, which has its own network. | `session.webRequest` | medium | **Do not do**; stated as theater in §7 |
| **L11 OS app sandbox** (macOS App Sandbox, Windows AppContainer) | Would contain *main*. Requires packaging and signing, which do not exist; Electron has no supported AppContainer path for main. | entitlements | packaging project | **Do not do now** |
| **L12 Should unreviewed code run at all?** | A consent dialog when a new or changed extension folder (id + version + content hash) appears, listing its permissions, stored in `install-state.js`. Content scripts keep their explicit opt-in. | `dialog.showMessageBox` | small–medium | **Defer to ROADMAP #10** (lifecycle UI); dropping the folder *is* consent today |

---

## 5. Functionality preservation contract

Stages: **S1** = L1 + L2 (filesystem). **S2** = L3 + L4 + L5 (gates). **S3** = L6
(optional). **S4** = L7 (sandbox). **S5** = L8 (rejected; listed only to show what it would
cost).

Cell values:

- **U** — unaffected.
- **B** — needs a broker change in main.
- **C** — needs a new channel.
- **X** — breaks.
- **G** — narrowed on purpose: a context Chrome does not allow loses access. Shipped
  extensions are unaffected.

Every non-U cell is checked by the test named in the table after this one.

| Feature | S1 | S2 | S3 | S4 | S5 |
| --- | --- | --- | --- | --- | --- |
| `panels.create` + `onShown(window)` / `onHidden` | U | U | U | B¹ | **X** |
| `chrome.storage` (local / sync / session, `onChanged`) | U | U | U | B¹ | U |
| `chrome.i18n` (sync XHR to own origin, manifest/CSS) | B² | U | U | B¹ | U |
| `devtools.network` + `webRequest` | U | G³ | U | B¹ | U |
| `inspectedWindow.eval` / `reload` | U | G³ | U | B¹ | U |
| `chrome.downloads` | B⁴ | U | U | B¹ | U |
| `notifications`, `alarms` | U | U | U | B¹ | U |
| `options_ui` window | U | B⁵ | U | B¹ | U |
| Background worker (load, lifecycle, router peer, ESM imports) | B² | B⁵ | B⁶ | B¹ | U |
| Content bridge (`tabs.sendMessage`, opt-in injection) | B² | U | U | U | U |
| CDP bridge (frontend session, host commands) | U | B⁷ | U | U | U |
| `InspectorFrontendHost.save` / `append` / HAR export | B⁴ | U | U | B¹ | U |
| Frontend preferences, `bringToFront`, context menu | U | B⁸ | U | B¹ | U |
| Theme (`themeName`, `setThemeChangeHandler`) | U | U | U | B¹ | U |
| Dispatch channel (host → frontend) | U | U | U | B¹ | U |
| `tabs.create` / `openInNewTab` | U | U | U | U | U |

Footnotes:

1. Every preload-backed feature depends on the bundle reproducing today's module graph. No
   behavior change is intended; the whole Electron suite is the net.
2. Realpath containment applies to every resolver caller (manifest, `_locales`, CSS,
   bootstrap `?script=`, content-script `js`). Legitimate in-folder files are unaffected, and
   so is an extension folder that is itself a symlink (the root's realpath is the
   reference).
3. Calls from a worker, an options page, or an extension without `devtools_page` now fail
   with lastError. `webRequest` in a worker keeps working via its grant.
4. Temp + rename; a name clash yields ` (1)`, not an overwrite. **Holds as written (issue
   #22)** — plus the two rules the row did not have: only a partial this download created is
   ever unlinked, and a symlink at the target is refused. A dialog choice and a `fixedPath`
   re-save are used as given, which is what keeps `savedURL`/`append` working.
5. Worker/options windows can no longer navigate off their own extension or `window.open`.
6. A worker's subresources are same-extension, so they pass.
7. Only the frontend's `Origin` (or none) may connect.
8. Only the frontend may call.

**Safety nets: existing test → assertion to add.**

| Cell(s) | Existing test | Assertion to add (or change) |
| --- | --- | --- |
| S1 i18n / worker / content (²) | `tests/background-worker-electron.test.js` (suite at `:570`), `tests/i18n-electron.test.js`, `tests/content-scripts-registry.test.js` | Stage an extension with an in-folder symlink resolving outside the root: the fetch is 404, while a symlinked extension *root* still serves. Existing traversal and bootstrap assertions stay green. |
| S1 downloads / save (⁴) | `tests/save-service.test.js`, `tests/host-primitives.test.js` (real `fs`), `tests/tier2-worker-electron.test.js` (the real-process save) | **Landed (issue #22).** A pre-existing file survives (a) a failed fetch, (b) a malformed `data:` URL, (c) a failing write, (d) a cancel — all four against the injected filesystem, and (a), (b), (c) plus the symlink case again against the real `fs` in a temp dir, where the link's target sits outside it. A clashing name produces ` (1)`, and the counter keeps counting. The old `:272-278` assertion is inverted: the *partial* is unlinked and nothing else in the directory can be. A symlink at the target is refused, not followed, and its target outside the directory is proven untouched. A failed re-save via `fixedPath` keeps the earlier file. Plus: the staged create is exclusive (`flag: "wx"`), a partial left by an earlier run is stepped around rather than unlinked, two concurrent same-name downloads get two files, a failed download releases the name it held, and a directory the shell cannot `lstat` stops the download instead of reporting its name free. |
| S2 network / eval (³) | `tests/extension-frame-electron.test.js` (the harness registers its host as the frontend via `setFrontendContents` in `extension-frame-harness.js`), `tests/inspected-window.test.js`, `tests/delivery-scope.test.js` (its live-push suite landed with F6: the harness runs the production CDP bridge against `tests/fake-rn-app.js`, and `--observe-frame-sends=on` records the pushes so a filtered-out one is observable), `tests/background-worker-electron.test.js` | A panel frame still evaluates. A worker's `inspectedWindow.eval` returns `isError` with the DevTools-context reason. graphql's worker still receives `webRequest` deliveries (the panel-frame half of that is measured as of F6; the worker half is still to assert). `NETWORK_GET_BODY` from a worker is refused. |
| S2 windows (⁵) | `tests/background-worker-electron.test.js`, `tests/options-and-requests.test.js` | A worker that sets `location.href` to http stays on its bootstrap URL. `window.open` from a worker creates no window (count `BrowserWindow.getAllWindows()`). |
| S2 CDP (⁷) | `tests/cdp-bridge.test.js` | A client with a foreign `Origin` is rejected and does **not** evict the current client. A client with the frontend origin, or no `Origin`, connects. Default bind is loopback. **Landed (issue #23)**, plus: a refused client cannot get one command upstream, a second client while attached is refused (`close 4001`) instead of evicting, a reload still reattaches, an unreachable owner is replaced after the probe, and `DEVTOOLS_CDP_ALLOWED_ORIGINS` is unset-by-default. |
| S2 frontend-only (⁸) | `tests/frontend-host-electron.test.js` (sets `DEVTOOLS_FRONTEND_URL`, `frontend-host-harness.js:48,64`), `tests/theme.test.js` | Prefs round-trip from the frontend. `PREF_SET` from a non-frontend main frame (a navigated window) returns refused and does not write. |
| S3 (⁶) | `tests/background-worker-electron.test.js:679-690` | **Flip** assertion 5: the sibling fetch is refused unless the file is web-accessible. The worker's own ESM import still loads. |
| S4 (¹) | `tests/security.test.js` (pins the prefs table), the full `*-electron.test.js` set | `sandbox === true` in the table. In a frame, `process.sandboxed === true`, and the page-world assertions stay as they are. The preload under test is the **bundled** file. |
| S5 | `tests/panel-events-electron.test.js` | — (rejected: `onShown(window)` would fail) |

---

## 6. Recommended next steps (only the ones recommended)

The order is by "plain JavaScript can reach it" first, then by cost. The cost ranking that
will be folded in later may reorder steps 1–3. Nothing here argues for step 4 ahead of them.

**Step 1 — filesystem containment (F1 + F2).**

- *Status:* **the F2 half is done** (the write and delete side). Staged partial + rename,
  `uniquify` by default, `overwrite` only by name, symlink refused, cleanup limited to the
  download's own partial — see `src/main/save-service.js` and `tests/save-service.test.js`
  (issue #22). The F1 half (the read side) is closed in code and tested; its *prose* closure in
  §1.1/§3.2 was lost in the stack merge and needs re-landing there.
- *Closes:* line (b) completely: reads stay inside the folder, and no write can modify or
  delete a pre-existing file.
- *Cost:* ~40 lines in `extension-server.js` and `save-service.js`, plus the test edits in §5.
  About half a day.
- *Could break:* an extension whose files are symlinks *within* its own folder (still fine);
  code that expects a re-download to overwrite — it now gets ` (1)`, as in Chrome. Measured
  against this repo's own consumers: the frontend's `save`/`append`/`close` and HAR export are
  unaffected because a dialog choice and a `fixedPath` re-save are deliberately *not*
  uniquified (`tests/host-primitives.test.js`, `tests/frontend-host-electron.test.js`).
- *Proof:* §5 rows S1. Each rule above is additionally mutation-checked: staging, the cleanup
  target, the symlink refusal, the default conflict action, the `wx` create, claim release, the
  dot-name refusal, `lstat` vs `stat` in the real backend, and the uniquify counter were each
  broken in turn and each broke at least one named test. (The claim-before-probe *ordering*
  itself is the one rule no in-process mutation can show failing: Node's FIFO microtask queue
  makes a late claim resolve in the same order the probe would have, so only a second real
  writer could expose it. The claim map it protects is mutation-covered; the ordering is held
  so that stays true if the gap around the probe ever grows.)

**Step 2 — ambient-authority gates (F3 + F4 + F5).**

- *Status:* **the F3 half is done** (the CDP socket). Loopback-default bind, `verifyClient`
  on the frontend origin + `DEVTOOLS_CDP_ALLOWED_ORIGINS`, Origin-less accepted from a
  loopback peer only, first-wins ownership with a liveness probe — see
  `src/main/cdp-bridge.js` and `tests/cdp-bridge.test.js` (issue #23). F4 and F5 are open.
- *Closes:* line (a) for navigated extension windows; DevTools authority held by non-DevTools
  contexts.
- *Cost:* ~50 lines across `ipc.js`, `background-host.js`, `options-host.js`.
  About one day including tests.
- *Could break:*
  - a third-party extension calling `inspectedWindow.eval` from its worker. Chrome forbids
    that too; no shipped extension does it (grep: only panel scripts use it) [code].
  - an options page with external links (route them through the tabs policy).
- *Proof:* §5 rows S2.

**Step 3 (optional) — `rozenite://` per-extension reads (L6).** Do it only if step 1 leaves
`extension-server.js` open anyway. Low value.

**Step 4 (insurance) — sandbox + bundled preload (L7).** Do it before any packaged
distribution, or before manifest-driven content scripts (ROADMAP #3, which is stacked behind
it for good reason). It buys containment of renderer exploits only.

**Deferred or rejected, with why:**

| Item | Stance | Why |
| --- | --- | --- |
| Panels on own `WebContentsView` / partition (L8) | Do not do | Breaks `onShown(window)`; a rewrite; nothing to gain once L7 lands |
| `utilityProcess` for workers (L9) | Do not do | It is a Node process; it would *add* authority |
| Per-extension partitions for worker/options windows | Defer | Isolates cookies/cache nobody privileged uses |
| `host_permissions` enforcement (L10) | Do not do | Leaky egress control (downloads in main, `eval` in the app) would be theater |
| OS app sandbox (L11) | Do not do now | Requires packaging/signing that does not exist |
| Consent prompt / integrity pinning (L12) | Defer to ROADMAP #10 | Dropping a folder is consent today; the prompt belongs with the lifecycle UI |
| Content-script identity hardening | Do not do | One shared JS realm (Hermes has no isolated worlds): any in-realm token can be read by any other script there |

---

## 7. What we consciously accept

Residual risk after steps 1 and 2, stated so it can stop being worried about:

1. **An extension runs arbitrary JavaScript in its own pages and its always-on worker**, and
   can send anything it can see to any server. Neither `host_permissions` nor CSP limits egress
   here. Installing it is consent.
2. **A DevTools extension can run arbitrary JS in the inspected app** (`inspectedWindow.eval`)
   and read its network traffic, including bodies and headers. Chrome grants exactly this to
   every devtools extension. After step 2 it is limited to DevTools contexts of extensions
   declaring `devtools_page`, but it is not limited further.
3. **Opted-in content scripts share the app's single JS realm.** They can read and overwrite
   app globals and each other, and they can claim another opted-in extension's identity on the
   binding. Mitigation is the opt-in itself (`DEVTOOLS_CONTENT_SCRIPTS`).
4. **`chrome.downloads` without `saveAs` creates files in `~/Downloads` with no prompt.** It is
   unbounded in size and count (disk fill), and its source fetch runs from main with no CORS
   (a blind request to localhost/LAN with a status-text oracle). Chrome downloads have the
   same reach.
5. **Until step 4: a Chromium renderer exploit in any extension page is code execution as the
   user.** No OS containment. Electron's Chromium lags Chrome's security releases.
6. **Rogue Metro / frontend fork on `127.0.0.1:8081` is the frontend.** It owns the app it
   serves and the frontend's channels; saves remain dialog-gated.
7. **No signature, review, version pinning, or uninstall UI.** A folder whose contents change
   (git pull, archive re-extract) runs the new code on the next launch, with the same grants.
8. **Extension A can read extension B's shipped files** (until step 3). It cannot read B's
   storage, frames or messages.
9. **`permissions.request` grants nothing, and `host_permissions` means nothing.** The manifest
   on disk is the only authority.
10. **The test seams are honoured in every run today**, because nothing is packaged. Only the
    environment can set them.
11. **`chrome.notifications` cannot dismiss**, and `getPermissionLevel` reports platform support,
    not consent ([LIMITATIONS.md](LIMITATIONS.md)).

---

## 8. Open questions

- Does the frontend's `?ws=localhost:9223` still connect when the bridge binds `127.0.0.1`
  only? Chromium usually falls back across addresses, but this is unmeasured. Binding both
  loopbacks avoids the question.
  **Measured (F3 fix, `tests/cdp-bridge.test.js`):** the bridge binds `127.0.0.1` and `::1`
  as two `ws` servers on one port, and the suite now dials `ws://localhost:<port>` for real
  (plus `[::1]` and `127.0.0.1` each, checking the family each landed on), so the promise
  holds by test rather than by hope. A `127.0.0.1`-only bind also accepted a `localhost`
  dial on the machine originally tested — resolver luck on one machine, not a contract; we
  bind both so the behavior does not depend on the resolver. That the **real** patched
  frontend connects remains a device-run item; the socket-level behaviour is covered.
- Do any third-party devtools extensions in the wild call `chrome.devtools.*` from a worker,
  relying on this shell's superset? Chrome forbids it, so step 2 would align with Chrome, but
  the population is unknown.
- Is `rozenite://` meant to be a secure context? The `frame-security.js:33-35` comment says
  `secure`, but the registration does not include it. Measure `isSecureContext` in an extension
  page. This decides `crypto.subtle` / clipboard availability, not security.
- Does `webRequest.onBeforeRequest` report `details.frame` for requests from a **worker's**
  module graph and from the sync i18n XHR? Measured here for iframe pages only; this must be
  measured before relying on L6.

---

## Appendix: how the [measured] claims were obtained

All runs were on macOS with Node 24 and Electron 38.0.0 (the main checkout's binary). Scripts
lived in `/tmp`; nothing in the repo was changed by them.

- **F2 / §3.3:** `createSaveService` from `src/main/save-service.js` with real `fs` and a temp
  dir as `downloadsDir`. Pre-existing files at the target name were removed after a rejected
  fetch, after a malformed `data:` URL, and for a URL-derived name. Overwrite was silent. A
  pre-existing symlink was followed. `..` failed with `EISDIR` and nothing changed.
  **That probe is now committed** — the same experiment against the same real `fs`, in a temp
  dir, with the symlink's target planted outside the downloads dir so the escape (and its
  closing) is observable rather than argued: `tests/save-service.test.js` ("F2 on the real
  disk…"). The `..` case is a unit assertion there, and the behavior it recorded changed: a
  whole-dot name is now refused before anything is created.
- **F1:** a standalone Electron app that `require`s the worktree's
  `src/main/extension-server.js`, with `DEVTOOLS_EXTENSIONS_DIR` pointing at a temp folder.
  Content outside the extension root was served for both a file symlink and a directory
  symlink.
- **Fact 5:** a two-host custom scheme registered with the same privileges as `rozenite`.
  Cross-host fetch was readable (`basic` even for `no-cors`); cross-host DOM access threw
  `SecurityError`. The `protocol.handle` request had no `Origin` and an empty `referrer`.
  `webRequest.onBeforeRequest` fired with `details.frame.url` set for subresources.
- **F4:** hidden windows with this repo's extension prefs and a preload mirroring
  `src/preload/index.js`. A self-navigation to http committed, and the "frontend" branch of the
  preload ran and reached an ungated `ipcMain.handle`. `window.open` created a visible window,
  sandboxed and without the preload.
- **F3:** `createCdpBridge` from `src/main/cdp-bridge.js` (with `ws` from the main checkout).
  `lsof` showed `*:<port>`. A client with a foreign `Origin` connected and closed the earlier
  client with "replaced by a new frontend connection". The port was also reachable through the
  machine's non-loopback address.
- **Fact 6:** `sandbox: true|false` × `nodeIntegrationInSubFrames: true|false`, checking where
  the preload ran and what it could `require`.


