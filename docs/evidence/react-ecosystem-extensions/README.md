# React-ecosystem DevTools extensions, unmodified, against an RN app

Run on 2026-11-24. The five most-installed Chrome DevTools extensions for React developers
after React DevTools (which React Native DevTools already ships), downloaded from the Chrome
Web Store as signed `.crx` files and dropped into `extensions/` unchanged. The host reads
each `.crx` in place, verifies its signature and derives Chrome's id from the key.

| Extension (Chrome Web Store id) | Version | Users¹ | App side (`app/demos/`) | Result |
| --- | --- | --- | --- | --- |
| Redux DevTools (`lmhkpmbekcpmknklioeibfkpmmfibljd`) | 3.2.12 | 1,000,000 | Redux Toolkit store, `devTools: {name}` | ✅ both ways |
| Apollo Client Devtools (`jdkknkkbebbapilgoeccciglkfbmbnfm`) | 4.26.8 | 200,000 | Apollo Client 4, `devtools: {enabled: true}` | ✅ |
| TanStack Query DevTools (`annajfchloimdhceglpgglpeepfghfai`) | 1.1.0 | 10,000 | `globalThis.__TANSTACK_QUERY_CLIENT__ = queryClient` | ✅ both ways |
| Relay Developer Tools (`ncedobpgnmkhcmnnkcimnobpfepidadl`) | 0.9.17 | 5,000 | relay-runtime 21 environment | ✅ |
| React Context DevTool (`oddhnidmicpefilikhgeagedibnefkcf`) | 4.4 | 30,000 | Context + `useReducer` | ✅ |

¹ chrome-stats.com snapshot, 2026-11-24.

Setup: iOS simulator (iPhone 17 Pro), dev client built from `app/` (Expo SDK 58, React Native
0.88.1, Hermes), Metro with `WITH_ROZENITE=true`, the shell with
`DEVTOOLS_CONTENT_SCRIPTS='<all_rn_targets>'`. The app's DevTools target reports
`supportsMultipleDebuggers: true`, so the host's own CDP session attached next to the
frontend's. Panels were opened and screenshotted over the shell's remote-debugging port; the
app was driven with taps on the simulator.

## What was observed

**Redux DevTools** ([redux-devtools.png](redux-devtools.png)). The instance appears under the
store's name ("PoC Redux store"); `@@INIT`, `cart/addItem` ×2 and `cart/bumpFirst` appear as
they are dispatched, with diffs. Back the other way: the panel's **Reset** set the app's store
back to its initial state (the app then read "Redux cart: 0 lines, 0 items"). The worker
logged `Message from tab …: INIT_INSTANCE`, i.e. the instance announcement posted before the
content script existed reached the worker (the claim, below).

**Apollo Client Devtools** ([apollo-client-devtools.png](apollo-client-devtools.png)). The
client connects (Apollo Client v4.3.8 shown); the `ApolloContinent` query, its document and
variables appear after the app runs it.

**TanStack Query DevTools** ([tanstack-query-devtools.png](tanstack-query-devtools.png)).
Both `["posts", {user}]` queries, their status, observers and data. Back the other way: the
panel's **Trigger Error** turned the app's query into its error state (the app then read
"error"), and **Restore Error** put it back.

**Relay Developer Tools** ([relay-devtools.png](relay-devtools.png)). The store explorer
lists the `Country`/`Continent` records the query wrote; the Network tab lists each
`queriesCountryQuery` with its text, variables and response.

**React Context DevTool** ([react-context-devtool.png](react-context-devtool.png)). Finds the
renderer (react-native-renderer@19.3.0), lists every Context in the tree (the app's
`SettingsContext`, and `ApolloContext`/`ReactRedux`/QueryClient from the other demos) and the
`settingsReducer`; actions dispatched after the panel opened (`toggleTheme`, `bigger`) are
listed with the resulting state. The built-in React DevTools Components panel kept working
next to it ([react-devtools-components.png](react-devtools-components.png)).

**MobX Developer Tools** ([mobx-devtools.png](mobx-devtools.png)), the existing folder,
re-checked after its hook moved onto the early installer: actions and reactions as before.

## What it took

Nothing in any extension was changed. What the host gained, each because a named extension
needed it (all in `src/electron/extensions/`, covered by `tests/content-scope.test.js`):

| Need | Extension | Change |
| --- | --- | --- |
| `document.title`, `navigator.userAgent`, `location.href`, `new CustomEvent`, `class extends Event` in content scripts | Redux, TanStack (WXT runtime) | per-extension browser shims in the scope, bound as bare names, never on the app's global |
| a `MessagePort` handed over with `postMessage(…, [port])`; `MessageEvent.prototype` accessors; `isTrusted` | Apollo | `MessageChannel`/`MessagePort`/`MessageEvent` in the scope; bus events are trusted `MessageEvent`s carrying their ports |
| `chrome.storage.sync.get` in a content script | Redux | `chrome.storage` for content scripts, as untrusted contexts of the host's one storage |
| `globalThis.chrome` meaning the extension's own API | TanStack | the scope answers `chrome` with the extension's view |
| `<script src=chrome.runtime.getURL(f)>` into the MAIN world | Relay | `load-script`: the extension's own file, run in its scope |
| `inspectedWindow.eval("window.postMessage(…)")` reaching the content script | Relay | eval runs in the calling extension's MAIN world (its scope) |
| the hook present before the library loads | Redux, Relay (and MobX) | `early-main-world.js` + Metro polyfill; early-run files are not run again |
| a message posted before the content script exists | Redux | the bus keeps it for the ISOLATED world's first injection |
| React DevTools' `react-renderer-attached` announcement | React Context DevTool | the scope hears it when the hook has a renderer |
| `chrome.runtime.onConnectExternal`/`onMessageExternal` | Redux (worker) | inert events, as Chrome always has them |
| `chrome.commands.getAll` iterated as an array | Redux (worker) | Chrome's `Command[]` shape |
| a UA without `Electron/` | Redux (worker and panel take an "Electron port" code path otherwise) | the host's session and the fallback UA drop the token |

## Second pass: the rest of each extension

Same setup, same day. The app gained what these features need: Redux `trace: true` and an
RTK Query API; an Apollo mutation (GraphQLZero, by per-operation `context.uri`); a TanStack
`useMutation`; Relay `applyUpdate` (optimistic) and `commitLocalUpdate`. "→ app" means the
panel's action was read back from the app's own UI or store, not from the panel.

| Extension | Feature | Result |
| --- | --- | --- |
| Redux | Trace tab ([redux-trace.png](redux-trace.png)) | ✅ Hermes stack frames of the dispatch |
| Redux | Jump to an action → app | ✅ app at "2 lines, 2 items" after jumping to the 2nd `addItem` |
| Redux | Skip an action → app | ✅ skipping the 1st `addItem` recomputed the app to "2 lines, 3 items" |
| Redux | Dispatcher → app ([redux-dispatcher.png](redux-dispatcher.png)) | ✅ a typed `{type: "cart/addItem", …}` added a line in the app |
| Redux | Lock changes → app | ✅ app dispatches ignored while locked, applied again after unlock |
| Redux | Export / Import → app | ✅ `state.json` (2,795 bytes) exported; importing it into a reset store restored "4 lines, 5 items"¹ |
| Redux | Log monitor, Chart ([redux-chart.png](redux-chart.png)), RTK Query ([redux-rtk-query.png](redux-rtk-query.png)) | ✅ |
| Apollo | Mutations tab ([apollo-mutations.png](apollo-mutations.png)) | ✅ document and variables |
| Apollo | Cache, live cache writes ([apollo-cache-writes.png](apollo-cache-writes.png)) | ✅ `ROOT_QUERY`/`ROOT_MUTATION`/`Post:101`; a write recorded as the app queried |
| Apollo | Memoization cache ([apollo-memoization.png](apollo-memoization.png)) | ✅ |
| Apollo | Explorer → app ([apollo-explorer.png](apollo-explorer.png)) | ✅ schema introspected and the query run **through the app's client** (`sendRequestsFrom=parent`); the panel then listed it as the client's second query |
| TanStack | Mutations tab ([tanstack-mutations.png](tanstack-mutations.png)) | ✅ variables, data, state |
| TanStack | Trigger Loading / Restore → app | ✅ app showed "fetching…", then its data again |
| TanStack | Invalidate, Reset, Remove | ✅ refetch; refetch; query gone from the cache |
| TanStack | Data Explorer edit → app | ✅ deleting an item in the panel took the app from 3 posts to 2 |
| Relay | Optimistic Updates ([relay-optimistic.png](relay-optimistic.png)) | ✅ `name: "Polska (optimistic)"` while applied |
| Relay | Event Logger ([relay-event-logger.png](relay-event-logger.png)) | ✅ snapshot / optimistic update / restore / publish / notify events |
| Relay | Store Explorer record details, Snapshot tab | ✅ including the local update (`capital: "Warsaw …"`) |
| Relay | Anything panel → app (Take Store Snapshot's refresh) | ❌ **upstream bug**: Relay DevTools 0.9.17's own frontend wall has `send` only and its Bridge calls `_wall.sendAll` (`TypeError: t._wall.sendAll is not a function`, `build/main.js`). The panel's copy of the store therefore keeps a reverted optimistic value until reload. Nothing in the host is involved. |
| React Context | Dispatch Action → app ([react-context-dispatch.png](react-context-dispatch.png)) | ✅ `{"type":"reset"}` from the panel reset the app to "theme light, font ×1" |
| React Context | Diff view ([react-context-diff.png](react-context-diff.png)), Context value view | ✅ |

¹ Export is a plain blob download. The run allowed downloads into a folder over CDP
(`Browser.setDownloadBehavior`) so no native save dialog opened; the shell's own handling of
downloads (a dialog) was not exercised.

### What the second pass fixed in the host

- **Emoji in an evaluate.** Hermes refused to compile any `Runtime.evaluate` whose source held
  a character outside the BMP (`Invalid UTF-8 code point 0xd83c`), however the CDP frame encoded
  it; one 🇵🇱 in a Relay record dropped every message carrying it. Such characters are now sent
  as JS escape pairs (docs/features/INSPECTED-WINDOW.md).
- **Content scripts are not runtime peers.** A devtools page's `runtime.connect` also opened in
  the app, so Relay's worker relayed panel traffic into the app. Chrome never routes
  `runtime.*` to content scripts; neither does the router now (docs/features/RUNTIME-MESSAGING.md).
- **`chrome.webNavigation`** exists (events never fire, frame queries answer `null`). Relay's
  devtools page registered `onBeforeNavigate` and threw without it.

## Not exercised

- Android, and a physical device: this run is the iOS simulator only.
- Apollo cache editing, Redux remote DevTools and "Persist state history" across reloads,
  Relay environment switching (the app has one environment).
- Each extension's popup (`action`): this host has no toolbar (docs/LIMITATIONS.md).
