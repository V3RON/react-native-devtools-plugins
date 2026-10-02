// Responder for panel.html's runtime-messaging checks.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[ping] got", message, "from", sender && sender.id);
  if (message && message.type === "ping") {
    sendResponse({ type: "pong", from: chrome.runtime.id });
    return;
  }
  if (message && message.type === "async-ping") {
    setTimeout(() => sendResponse({ type: "async-pong" }), 10);
    return true; // claims async, like Chrome requires
  }
});

chrome.runtime.onConnect.addListener((port) => {
  console.log("[ping] port connected:", port.name, "from", port.sender && port.sender.url);
  port.onMessage.addListener((msg) => {
    console.log("[ping] port msg:", msg);
    port.postMessage("port-pong:" + msg);
  });
  port.onDisconnect.addListener(() => console.log("[ping] port disconnected"));
});
