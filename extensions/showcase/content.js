// DevTools Showcase: content script (the "bridge" opt-in).
//
// In Chrome this runs in every page the manifest matches. In the RN DevTools shell
// it is injected ONLY when the user opts in (DEVTOOLS_CONTENT_SCRIPTS=showcase),
// and is otherwise never read, so declaring it is safe by default. All it does is
// answer one message, so the panel's "content-script bridge" row can tell a live
// bridge from an absent one.
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (m && m.type === "showcase-ping") {
      sendResponse({
        type: "showcase-pong",
        from: "content-script",
        at: Date.now(),
        // `location` is absent in some JS targets; report rather than throw.
        where: typeof location !== "undefined" ? location.href : "(no location)",
      });
    }
    return undefined;
  });
}
