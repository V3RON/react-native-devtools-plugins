// Which host->frame network deliveries a given frame may receive
// (docs/features/EXTENSION-MANAGEMENT.md, docs/features/WEBREQUEST.md).
//
// One CDP capture feeds two Chrome APIs, so one message stream feeds both, and
// the permission has to be applied per message rather than per subscription:
//
//   - `chrome.webRequest` requires the declared `webRequest` permission
//     (Chrome's own rule). Without it the pre-completion lifecycle steps that
//     feed onBeforeRequest / onBeforeSendHeaders / onSendHeaders /
//     onResponseStarted / onBeforeRedirect are not sent at all.
//   - `chrome.devtools.network` requires NO permission in Chrome, and its
//     `onRequestFinished` consumes the SAME `completed` / `error` messages,
//     along with `navigated` and `status`. Those keep flowing to every frame —
//     dropping them would break `devtools.network` for an extension that
//     legitimately declares no permissions (Altair: `storage`, `tabs`,
//     `notifications` only).
//
// So this filter is not "no data without the permission" and does not claim to
// be: it is "no webRequest lifecycle without the permission". The complementary
// half lives in src/chrome-shim/permission-gate.js, which refuses to register a
// denied extension's listeners at all. Together they mean a frame without
// `webRequest` cannot receive an onBeforeRequest/onSendHeaders/onResponseStarted
// detail object by any route — asserted in tests/delivery-scope.test.js and
// end-to-end in tests/extension-frame-electron.test.js.
//
// Pure: `grants` is the host's own per-frame verdict from src/main/ipc.js, and
// nothing here knows about Electron.

// Deliveries whose payload is a webRequest `details` object.
const WEB_REQUEST_ONLY = new Set([
  "request",
  "sendHeaders",
  "response",
  "redirect",
]);

/**
 * @param {{webRequest?: boolean}} grants the frame's granted permissions
 * @param {string} kind the delivery's payload kind
 * @returns {boolean} whether this frame may receive it
 */
const deliveryAllowed = (grants, kind) =>
  !WEB_REQUEST_ONLY.has(kind) || Boolean(grants && grants.webRequest);

module.exports = { WEB_REQUEST_ONLY, deliveryAllowed };
