# Inspected window (`chrome.devtools.inspectedWindow`)

| | |
| --- | --- |
| **Status** | ❌ not implemented |
| **Tier** | 1 |
| **Blocked by** | — (CDP connection already exists) |

## Chrome surface

- `tabId` — id of the inspected tab
- `eval(expression, options?, cb)` — run JS in the inspected page; options:
  `useContentScriptContext`, `inspectOnDevtoolsFrontend`, `frameURL`; returns JSON-ish
  result + `exceptionInfo`
- `reload()`
- `getResources(cb)` (deprecated) / `getResourceContent(url, timeout, cb)`

## RN mapping (the good news)

`eval` → CDP `Runtime.evaluate(returnByValue: true, awaitPromise: true)` against the RN
JS context. This is **the highest-fidelity, highest-value bridge to the app**: state
debuggers (Redux/MobX/Vuex pattern: hook a `window.__X` global) work almost unchanged,
since Hermes+RN provide a `window` alias, `fetch`, `XMLHttpRequest`, timers.

| Sub-API | RN mapping | Fidelity |
| --- | --- | --- |
| `tabId` | synthetic constant | fine |
| `eval` | `Runtime.evaluate` | High; JSON-serializable values only; `frameURL` degrades; `useContentScriptContext` == same context (no isolated worlds) |
| `reload` | target reload if the CDP backend supports it | Medium |
| `getResources`/`getResourceContent` | `Debugger.getScriptParsed` + script source | Medium; DOM-resource semantics dropped |

## Plan

1. Route `eval` through the host to the frontend's CDP connection (the frontend owns the
   socket; host asks frontend, or via [dispatch-channel](DISPATCH-CHANNEL.md)
   `sendMessageToBackend`).
2. Map exceptionInfo/`CodeMirror`-style error objects into Chrome's `{value, exceptionInfo}`
   callback shape; promise-await with timeout.
3. `tabId` constant; `reload` best-effort; resources optional (Tier 2).

## Definition of done

Redux-DevTools-pattern extension: `chrome.devtools.inspectedWindow.eval("window.__REDUX…")`
returns real app data from a running RN app.
