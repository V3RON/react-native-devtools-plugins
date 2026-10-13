# Evidence: `InspectorFrontendHost.initialTargetId()`

Before: always `null`. Now: the id of the target the shell's CDP bridge is attached to
(Metro `/json/list` `id`), `null` when nothing is attached (after a 3 s wait) or the bridge is off.

Important finding: the frontend's only caller is `TargetManager.maybeAttachInitialTarget()`
(core/sdk), used by the `worker_app` entrypoint and only when the URL has `?browserConnection=true`.
The default `rn_fusebox` entrypoint (InspectorMain) never calls it. So the id is observable by loading
`worker_app.html?ws=...&browserConnection=true`, which is what this run does.

## Reproduce

```
xvfb-run -a node docs/evidence/initial-target-id/drive.js
```

Ports 9262-9266. `drive.js` starts headless Chromium (9262), a fake Metro on 9263 whose `/json/list`
entry has `id` = the page's CDP targetId and `webSocketDebuggerUrl` = Chromium's *browser* socket, then
the shell with the bridge ON (bridge 9264, Electron debug 9265, `--no-sandbox`). It hooks the frontend's
WebSocket before page scripts run, reloads, and records the frames.

## Files

- `frames.log` — the frontend called `initialTargetId()`, received the real id, sent
  `Target.autoAttachRelated {targetId: <that id>}`, and the page attached
  (`Target.attachedToTarget`, same targetId). The direct call
  `InspectorFrontendHost.initialTargetId()` returns the same id.
- `1-frontend-attached.png` — the frontend with the Network panel recording against the attached target.
- `2-application-origin-of-attached-page.png` — Application panel, a different state, populated from the
  attached page (Local storage lookup answered by the target).

Caveat: in `worker_app` the Console has no execution context (the target is attached as a worker-style
target, no Runtime.enable on a page), so Console evaluation is not demonstrable in this mode.
