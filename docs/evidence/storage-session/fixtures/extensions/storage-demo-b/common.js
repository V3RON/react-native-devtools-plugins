// Shared by every context of the demo extension (devtools page, panel, background
// worker, options page). Each context listens to chrome.storage.onChanged ON ITS OWN and
// reports what it heard to the panel with runtime.sendMessage, so the panel can render
// "who heard what" — every line below really came out of that context's own listener.
const describe = (changes, area) =>
  Object.entries(changes)
    .map(([key, change]) => {
      const was = "oldValue" in change ? JSON.stringify(change.oldValue) : "(absent)";
      const now = "newValue" in change ? JSON.stringify(change.newValue) : "(removed)";
      return `${area}.${key}: ${was} -> ${now}`;
    })
    .join("; ");

globalThis.watchStorage = (source, onLine) => {
  chrome.storage.onChanged.addListener((changes, area) => {
    const line = describe(changes, area);
    onLine && onLine(line);
    chrome.runtime.sendMessage({ demo: "heard", source, line }).catch?.(() => {});
  });
  chrome.storage.session.onChanged.addListener((changes) => {
    // Per-area event: same change, no area name in its arguments.
    chrome.runtime.sendMessage({
      demo: "heard",
      source,
      line: `session.onChanged (per-area): ${Object.keys(changes).join(", ")}`,
    });
  });
};
