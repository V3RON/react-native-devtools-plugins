# Content scripts (bridge-style)

| | |
| --- | --- |
| **Status** | 🟨 implemented behind an explicit opt-in (`DEVTOOLS_CONTENT_SCRIPTS`, default OFF) and **observed on a real device** — see [Live run](#live-run-the-definition-of-done-observed-on-a-device). The two fidelity gaps that run found are fixed and re-observed on the same device ([After the run](#after-the-run-the-two-gaps-fixed-and-re-observed)) |
| **Tier** | 2 — but strategically the most important Tier-2 item |
| **Blocked by** | [RUNTIME-MESSAGING.md](RUNTIME-MESSAGING.md) (real now); the CDP transport is real too ([src/main/cdp-bridge.js](../../src/main/cdp-bridge.js)) |
| **Code** | [src/main/content-scripts.js](../../src/main/content-scripts.js) (registry), [src/main/content-gate.js](../../src/main/content-gate.js) (opt-in), [src/main/content-bridge.js](../../src/main/content-bridge.js) (runner + app-side loader) |

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
   `src/tools/fake-cdp.js` path or future web support), Species A could run nearly for real since a
   DOM exists there.

## Known hard limits

- Hooks installed at attach time miss code that ran before attach (no clean
  `document_start` analog) — the familiar "reload to catch initial state" problem Redux
  DevTools users already know.
- No DOM APIs: any Species-B script that reaches for `document` (even trivially) breaks;
  consider an extremely thin `document` no-op shim to soften the most common cases, and
  nothing more.
- Third-party code executes **inside the user's app process** — heavier security/perf
  story than running it in DevTools; hence the explicit host-level opt-in below, which is
  off until a developer names the extensions that may run.

## Definition of done

A bridge-style content script from an unpacked extension is injected into a running RN
app on attach, hooks a global, and relays app → devtools-panel messages over the existing
CDP connection, with zero app-code changes.

**Met, and observed:** [Live run: the definition of done, observed on a device](#live-run-the-definition-of-done-observed-on-a-device).

## Implemented: what the design left open

The design above is what shipped, with four decisions it left open now settled. Each is
visible to a developer, so each is stated here rather than only in the code.

### Injection is opted in per extension, and the default is nothing

```bash
DEVTOOLS_CONTENT_SCRIPTS="my-ext.local,other.ext"   # extension ids
DEVTOOLS_CONTENT_SCRIPTS="<all_rn_targets>"         # every scanned extension
```

Unset (the default) injects **nothing at all** and says so once at startup. Third-party
code running inside the user's app is not something that should happen by surprise, so
this is stricter than Chrome by design — Chrome injects whatever a manifest declares.

`matches` patterns do **not** grant permission and never did become a question here: RN
targets are not keyed by URL, so a pattern can only be *reported* (`(informational)`).
Neither does a `content_scripts` entry in `permissions` — Chrome has no such permission
(MV3 rejects the string), so its absence is not read as disapproval and its presence would
not be enough either. What allows injection is the environment opt-in, and nothing else.
The full verdict for every entry of every extension is available from the bridge's
`report()` and is written to the console with the `[content-scripts]` prefix.

### The binding name is reserved, because RN's is session-global

`Runtime.addBinding` dispatches `bindingCalled` by binding **name** alone
(`RuntimeAgent.cpp`), not by context, so one name is one app-wide function and it clobbers
an existing global of that name. `__rozeniteContentBridgeDispatch` is therefore reserved by
this shell, and the host **probes for the binding before injecting** and injects nothing if
the app did not install it. That case is unrecoverable by construction — `sendToHost` is
the only way the loader has to report anything, and the binding is exactly what is missing —
so a shell that injected anyway would be producing scripts that can never talk to anyone.

A fresh `Runtime.executionContextCreated` (or `executionContextsCleared`) means the app has
a context with neither the binding nor the loader — RN's own
`RemovedBindingDoesNotSurviveReload` test is the authority — so the mesh seat is withdrawn
first and injection re-runs. Never a queue of deliveries addressed to a dead context.

### "Nothing answered" is reported as a failure, and `undefined` means a listener answered nothing

Issue #12 had refused to wire `chrome.tabs.sendMessage` rather than let an extension message
itself and read the success as "a page answered". That refusal holds — a tab message never
reaches the sender's own `runtime.onMessage` — and the API now has a real receiver: this
extension's content script, inside the inspected app.

What makes the wiring safe rather than merely convenient is that the app can say it heard
the message and has nobody listening (`nr: true`, plus Chrome's own "Could not establish
connection. Receiving end does not exist." text). The host turns that into a **rejected**
request. A resolved `undefined` is reserved for a listener that genuinely answered nothing,
because that is the one case where it is true. Likewise a response wait that expires says it
expired, and a session that died mid-send stays `pending` with a reason instead of being
reported as answered.

The same rule runs in the other direction, which took a device to find (see
[After the run](#after-the-run-the-two-gaps-fixed-and-re-observed)). An injected script
sending to a mesh with no peer used to be answered `undefined` too, because the router's
fan-out cannot tell "nobody could receive this" from "peers answered nothing" after the fact —
so the app-side sender asks `router.hasPeers` **before** sending and reports Chrome's
connection failure when it has nobody to talk to. And a delivery the app *refused* settles as
no receiver rather than as an empty answer. `sendMessage`'s own contract is unchanged: it
still resolves `undefined` with no peers, because the frame-side layers and their tests are
written against that, and a sender that needs to know can ask.

### One loader, merged rather than replaced

The loader is installed once and later runs return early, so a second extension's injection
cannot uninstall the first one's listeners. Each script is wrapped so the `chrome` it sees is
lexical and carries **its own** extension id — otherwise extension B's traffic would be
attributed to extension A. The global `chrome.runtime` belongs to the first extension
injected, and that is stated in the report rather than left to be discovered.

Members are copied **by descriptor**, which is not a detail: the merge builds an object by
iterating keys, so an accessor that is non-enumerable does not reach the script's view at all,
and one that is enumerable but read during the copy is frozen at whatever it returned then.
`lastError` is both — a getter onto live state, and the only way a script learns a call
failed. Flattened, every failure this host reports reached the app as `lastError: null`, i.e.
as a success; the fix is what makes the section above observable in the app at all. Copying
that way also stops the merge *running* a page's own getters, one of which was enough to abort
an injection.

### One entry, one evaluation per app context

`refresh()` is idempotent in its verdicts; a third-party script's side effects are not, and the
runner used to re-evaluate them on every pass. What is in the app context now is therefore
tracked per extension, keyed by the same `bindingGeneration()` that decides whether the binding
needs re-installing: same generation, same bytes → the pass reports the entry as injected and
`skipped`, and does not evaluate it. A new context generation, changed sources, or any
`withdraw` (session gone, contexts cleared, evaluate refused, dispose) makes the record go, and
the next pass injects for real — the re-injection `Runtime.executionContextCreated` exists for
still happens.

### What is *not* claimed

`npm test` covers the registry, the gate, the loader's semantics (executed in a `node:vm`
"app"), and the host's protocol behaviour against a scripted CDP backend. None of that is
evidence that a script ran inside a real Hermes context — and the `document`-free,
`ISOLATED`-world-less, pre-attach-blind limitations below are properties of the backend, not
things a unit test can discharge. The device run recorded below is what closes the definition
of done; the limitations are backend facts it does not claim to have tested.

## Live run: the definition of done, observed on a device

Verified 2026-10-02 against a real Hermes context on Android. The DoD's four claims each have
a quoted line below, and each was read back through a channel that does not depend on the
feature proving itself.

### The app

The emulator had only **Expo Go 55.0.7**, and this project is **SDK 57**, so Expo Go cannot
open it at all:

```
ErrorActivity message: This project requires a newer version of Expo Go.
```

A dev client is therefore the only route. `npx expo run:android` generated `app/android/`
(gitignored) and built it:

```
BUILD SUCCESSFUL in 2m 13s
160 actionable tasks: 149 executed, 11 from cache
```

One setup step is worth recording, because it is what stood between a fresh dev client and an
attached session. The app chooses its dev server from `PackagerConnectionSettings`, whose
default is baked in at build time (`--port 8081` here, while this machine also runs *another
project's* Metro there). With an empty `127.0.0.1:8099` on Metro and the app running, nothing
registered; setting the `debug_http_host` shared preference of the debug build to this
project's Metro is what produced a target:

```
<string name="debug_http_host">127.0.0.1:8099</string>
```

Metro's port was moved to 8099 precisely so that other project's 8081 stayed untouched.

That produced a real CDP target on Metro — `type: "node"`, which is exactly what the bridge's
discovery filters for — with no dev-menu interaction and no app-code change:

```
"title": "com.aitwar.devtoolspoc (unknown Android SDK built for arm64)"
"description": "React Native Bridgeless [C++ connection]"
```

### The fixture

An MV3 extension in a temporary folder (not `extensions/`), `permissions: ["tabs"]`, a
`background.service_worker`, and `content_scripts` matching `<all_rn_targets>`. Its content
script hooks a global, sends to the worker, and answers a tab message:

```js
globalThis.__ROZENITE_LIVE__ = "hooked";
chrome.runtime.sendMessage({ from: "content-script", marker: "DELAYED" }, callback);
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  sendResponse({ from: "content-script", saw: message });
});
```

The shell was launched against that folder with the extension allowlisted. `DEVTOOLS_CDP_PORT`
and `DEVTOOLS_METRO_PORT` are set because this machine already had a long-running `rn-cdp.js`
on the 9223 default and a foreign Metro on 8081:

```bash
DEVTOOLS_EXTENSIONS_DIR=<tmp>/ext-root DEVTOOLS_CONTENT_SCRIPTS=live-fixture \
DEVTOOLS_METRO_PORT=8099 DEVTOOLS_CDP_PORT=9224 \
DEVTOOLS_FRONTEND_URL="http://127.0.0.1:8099/rozenite/rn_fusebox.html?ws=localhost:9224" \
npm start
```

### 1. The gate let it through, and the runner injected it

```
[content-scripts] live-fixture[0]: live-fixture: allowlisted via "live-fixture"
[content-scripts] live-fixture[0]: injected content.js
```

### 2. The global really exists *inside the app*

Not taken on the log line's word: a plain WebSocket CDP client dialled the bridge's own port
and evaluated in the app's context — the same `Runtime.evaluate` the product uses, driven from
outside it:

```
RESULT: {"result":{"type":"string","value":"string|hooked"}}
```

The loader arrived too, in the app's own words:

```
{"binding":"function","loader":"object","proto":1}
```

### 3. The app → host leg (`Runtime.bindingCalled`) — the leg `6f31a7c` subscribed

The app-side callback saw a real answer, with no `lastError`:

```
{"response":{"from":"background-worker","got":"DELAYED"},"lastError":null}
```

and the worker, whose console is the shell's stdout, printed what it received:

```
[live-fixture] [fixture-worker] received from app: {"from":"content-script","marker":"DELAYED"}
```

To show that the payload rode the *binding* rather than some incidental channel, an
independent client called the reserved function straight from app code, bypassing the loader's
`chrome.runtime` entirely, and the host still received it:

```
globalThis.__rozeniteContentBridgeDispatch(JSON.stringify({t:"send",x:"live-fixture",s:"live-fixture#direct",m:{marker:"DIRECT_BINDING_PROBE"}}))
```
```
[live-fixture] [fixture-worker] received from app: {"from":"app-code-direct-binding","marker":"DIRECT_BINDING_PROBE"}
```

### 4. `chrome.tabs.sendMessage` reached the app and got its answer back

```
[live-fixture] [fixture-worker] tabs.sendMessage DELIVERED: {"from":"content-script","saw":{"from":"worker","probe":"ROZENITE_LIVE_TAB_PROBE"}}
```

The app confirmed it was the one that answered, and recorded the synthetic `sender.tab` the
host attaches. Trimmed for width, but the title is the real target's, not `about:blank`:

```
{"id":39849, … "title":"com.aitwar.devtoolspoc (unknown Android SDK built for arm64)","url":"about:blank","status":"complete"}
```

### The default-closed gate, in the same live setup

Same app, same fixture folder, `DEVTOOLS_CONTENT_SCRIPTS` unset:

```
[content-scripts] DEVTOOLS_CONTENT_SCRIPTS is unset, so NO content script is injected (docs/features/CONTENT-SCRIPTS.md)
[content-scripts] live-fixture[0]: live-fixture: not allowlisted. Nothing is injected unless DEVTOOLS_CONTENT_SCRIPTS names "live-fixture" or "<all_rn_targets>" (current: unset — the default, and the safe one)
```

Zero `injected content.js` lines that run, and the app itself, read back over CDP, was clean:

```
{"hooked":"undefined","loader":"undefined","binding":"undefined"}
```

The refusal a `tabs.sendMessage` gets with nothing injected is the expected default, and it
says why:

```
[live-fixture] [fixture-worker] tabs.sendMessage REFUSED: tabs.sendMessage: no content script of "live-fixture" is running in the inspected target, so nothing can receive this message. docs/features/CONTENT-SCRIPTS.md is the opt-in; its current state here is not injected (nothing allowlisted)
```

### Two things the run showed that the tests could not

**A script that sends in the same tick it is injected usually does not reach the worker.** The
fixture sent twice per injection — immediately, and 2.5 s later. Across three shell runs and
twelve injections, the delayed send arrived 11 times and the immediate one once. The app's
own callback for a lost send reported

```
{"response":"<undefined>","lastError":null}
```

which is precisely the shape this host reserves for "a listener answered nothing" — not for
"nobody was reached". So the message is swallowed silently rather than reported as a failure.
It is timing-dependent (the worker takes its mesh seat during shell startup, injection happens
during attach, and the order is not fixed), so an extension that sends from its first statement
can lose that message without any error to notice. Nothing was changed for this.

**The same entry is injected several times per live session** — four `injected content.js`
lines in each of three runs, alongside the deferred first pass, the attach, and the
`Runtime.executionContextCreated` re-injections (the fourth pass was not separately
attributed). 2.5 s of the fixture's own timer made each injection observable as exactly one
delayed send, which is how the count was read. `refresh()` is
documented as idempotent and its verdicts really are stable, and the loader's merge-not-replace
did keep exactly one listener in the app throughout — but re-evaluating a script whose *own*
side effects are not idempotent is not idempotent from the app's point of view. Not fixed here.

Both of those statements were true of the build that ran them, and both are now fixed. The
quoted lines above are kept verbatim as the record of that run; what changed, and what the
same device says now, is in
[After the run: the two gaps, fixed and re-observed](#after-the-run-the-two-gaps-fixed-and-re-observed).

### After the run: the two gaps, fixed and re-observed

GitHub issue #5 continued from this run. Each fix was checked by re-running the same app —
the same installed `app-debug.apk`, no rebuild — the same fixture folder, the same Metro port
(8099, so the other project's 8081 stayed untouched) and `DEVTOOLS_CDP_PORT=9224`, with one
change to the fixture worth naming: it now reports its own callback's outcome through the
reserved binding (`{t: "report"}`) as well as through the worker, because a script whose
extension has no worker cannot report *through* a worker — and the no-receiver case is exactly
the case with no worker to ask.

**1. A lost send is now reported as a failure, and the common case works.**

Three things were wrong, in a chain:

- The app's `send` path had no error path at all. It awaited `router.sendMessage` and
  answered the app with whatever came back, and that router answers "no peer existed" and
  "peers answered nothing" with the same `undefined`. The router now exposes
  `hasPeers(fromKey)` — read-only, additive, and it changes no existing send's contract — and
  the app-side sender asks it *before* sending. With nothing to receive the message the app
  gets Chrome's own text plus this shell's reason:

  ```
  Could not establish connection. Receiving end does not exist. The inspected app asked "nopeer-fixture" to answer, but no other context of that extension is registered in the messaging mesh, so nothing can receive this message. Its background worker or panel has not taken its seat yet (the worker registers while the shell starts up; injection runs when a debugger session attaches).
  ```

  Observed on the device, from an extension that declares no worker at all, in both API
  forms:

  ```
  [content-scripts] nopeer-fixture: the app reported "app-observation": no-peer send outcome: {"response":"<undefined>","lastError":"Could not establish connection. Receiving end does not exist. The inspected app asked \"nopeer-fixture\" to answer, but no other context of that extension is registered in the messaging mesh, so n
  [content-scripts] nopeer-fixture: the app reported "app-observation": no-peer promise outcome: rejected Could not establish connection. Receiving end does not exist. The inspected app asked "nopeer-fixture" to answer, but no other context of that extension is registered in the messaging mesh, so nothing can receive this messa
  ```

  Compare the old shape above: `lastError` is no longer `null`. A lost message now reads as
  lost, in `runtime.lastError` and as a rejected promise.

- The app's mesh seat was registered *after* its script was evaluated, and the extension's own
  background worker takes its seat during shell startup — the same window attach-time
  injection happens in. The seat is now taken before the script goes in, and an extension
  whose manifest declares a background worker stands down (honestly, `pending`, picked up by
  the sweeper) for at most three passes until that worker exists.

- Re-running the fixture against that build produced a *different* wrong answer, which is what
  exposed the real mechanism: `{"response":"<undefined>","lastError":"this extension is not
  injected"}`. `Runtime.addBinding` is fire-and-forget, so a send made from the script's first
  statement reaches the host **while the `Runtime.evaluate` running that script is still
  open**. Refusing that envelope is the other version of the same lie — the message in the
  host's hands is itself the proof that the script is running. The runner now flags the
  extension `evaluating` for the duration of the evaluate and the `send` path believes it,
  while `tabTarget` still demands `injected`: nothing may be sent *into* a context whose
  script may yet be refused. A delivery the app really does refuse now settles its router leg
  as **no receiver** (`__rozeniteNoReceiver`, with the app's reason) rather than as
  `undefined`, so a targeted `chrome.tabs.sendMessage` fails instead of being handed a shrug.

Those two runs together also **revise the diagnosis recorded above**. The original run's
`{"response":"<undefined>","lastError":null}` and this run's
`{"response":"<undefined>","lastError":"this extension is not injected"}` are the same host
behaviour — the immediate send was being *refused*, not silently dropped — and the only
difference is that this run could see the reason. The original run could not: the loader's
`lastError` never reached the script at all (the flattened-getter case under
[One loader, merged rather than replaced](#one-loader-merged-rather-than-replaced)), so a
refusal and a genuine empty answer looked identical from inside the app. "The message is
swallowed silently" was therefore accurate about what the app observed and wrong about the
mechanism — there was always a reason, and the app was blind to it. The 1/12 that arrived were
the sends where the evaluate happened to answer before the binding payload was processed.

Two honest caveats about this revision. It is inference across a build change: the original
observation cannot distinguish "refused, reason hidden" from "answered `undefined`", and the
proof that it was the refusal comes from the new build, where removing the `evaluating`
allowance reproduces the failure and adding it makes every immediate send arrive. And the
mesh-seat wait above never fired in either live run — the worker was already seated by the
time injection ran (log lines 12 and 20) — so `hasPeers` earned its keep on the device only in
the no-peer fixture, which exists precisely to exercise that case. It stays because the unit
tests show it is the difference between an honest error and a plausible success, not because
the device demanded it.

With all three in place, the same fixture, same device, same command:

```
[content-scripts] live-fixture: the app reported "app-observation": immediate-send outcome: {"response":{"from":"background-worker","got":"IMMEDIATE"},"lastError":null}
[live-fixture] [fixture-worker] received from app: {"from":"content-script","marker":"IMMEDIATE"}
[content-scripts] live-fixture: the app reported "app-observation": delayed-send outcome: {"response":{"from":"background-worker","got":"DELAYED"},"lastError":null}
[live-fixture] [fixture-worker] received from app: {"from":"content-script","marker":"DELAYED"}
```

The immediate send is delivered rather than merely reported honestly — the worker received
`IMMEDIATE`, which the run measured at 1/12 before.

**A Chrome-fidelity divergence found here, deliberately NOT fixed.** An injected script can
call `chrome.runtime.sendMessage("other-extension", msg)`, and the app-side loader
**discards that target id**: it keeps only its own extension id in the envelope, so the host
routes the message to *the sender's own* extension's peers. Measured directly, the wire envelope
for `chrome.runtime.sendMessage("other-extension.local", {hi:1})` from `ext-a` is

```
{"t":"send","x":"ext-a","s":"ext-a#1","m":{"hi":1}}
```

— the named extension is simply gone. In the live no-peer run that produced the mild symptom
(the call rejects with Chrome's "Receiving end does not exist.", because this extension had no
peer either), but the underlying behaviour is wrong: once a peer of the *sender's* extension
exists, a message aimed at a different extension is delivered to the sender's own worker and
panels, while Chrome addresses the named extension. The frame-side shim
(`src/chrome-shim/messaging.js`) does this correctly, rejecting any target id that is not the
caller's own, and `tests/content-loader.test.js` now pins the app-side flattening so it cannot
be forgotten. Not fixed here because doing it properly means extending the envelope protocol —
carry the target, and decide it host-side, where the caller's real extension id is host state
rather than something the app asserted — and an app-side-only check would be the shell
claiming knowledge of a mesh the app cannot see. Left for a human to place on the right layer.

**2. One entry is evaluated once per app context.**

The runner now remembers what it evaluated into the *current* app context, keyed by the same
`bindingGeneration()` the binding re-install already uses, and compares entries by their files
and bytes rather than by object identity. Later passes say so instead of re-running the
script's side effects:

```
[content-scripts] live-fixture[0]: content.js is already evaluated into this app context — not evaluated twice
```

The counts, both runs against the same device — `injected content.js` lines vs the new line:

```
live-fixture (worker present):  1 injected   2 "not evaluated twice"
nopeer-fixture (no worker):     1 injected   5 "not evaluated twice"
```

Down from four evaluations per session to one. The later passes are not individually
attributed — the deferred first pass, the attach, the `Runtime.executionContextCreated`
re-injection and the periodic sweep all run in one session and each of them used to
re-evaluate — but each of them now reports the truth instead of repeating the work. `skipped`
is in the report per entry so the difference between "injected" and "injected again" is
readable without the log.

The guard does not survive a genuinely fresh context: a new `contextEpoch` re-evaluates, an
entry whose sources changed re-evaluates (same context, new bytes — the old script must not be
what stays running), and `withdraw` — a dead session, cleared contexts, a refused evaluate,
`dispose` — forgets the record, because that is the one place "this context never ran it" is
not a bookkeeping guess. An entry the gate stops allowing mid-life loses its mesh seat as
well, so `tabs.sendMessage` cannot keep addressing a script this pass declined to run.

**Still open after this**, none of it new: no `document`, no isolated world, no hook on code
that ran before attach; `css` still a no-op; and the dedupe is per runner, so a *second* shell
attached to one app would still evaluate the script again.


### What the run did *not* exercise

`css` (no-op by design), `"world": "MAIN"` as a separate file, Ports from a content script,
multiple extensions injecting one app, and re-injection after an app reload (the
`executionContextCreated` path did fire once, when the frontend connected, and injection did
re-run). The limitations above are unchanged by this run: the script still has no `document`,
no isolated world, and no way to hook code that ran before attach.
