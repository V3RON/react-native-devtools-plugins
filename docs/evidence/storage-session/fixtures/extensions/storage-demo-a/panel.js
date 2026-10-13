const $ = (id) => document.getElementById(id);
$("id").textContent = chrome.runtime.id;
const wrote = [];
const heard = [];
const append = (list, el, line) => {
  list.push(line);
  $(el).textContent = list.join("\n");
};
const snapshot = async () => {
  $("snapshot").textContent = JSON.stringify(await chrome.storage.session.get(null), null, 2);
};

// What other contexts of this extension report hearing.
chrome.runtime.onMessage.addListener((message) => {
  if (message && message.demo === "heard") {
    append(heard, "heard", `[${message.source}] ${message.line}`);
  }
});
// And what this panel hears itself (it is a context like any other).
watchStorage("panel", () => snapshot());

$("write").onclick = async () => {
  // Read-modify-write against the extension's shared session storage, so a freshly
  // loaded panel carries on from what any other context left there.
  const counter = ((await chrome.storage.session.get("counter")).counter || 0) + 1;
  const value = { counter, by: "panel" };
  await chrome.storage.session.set(value);
  append(wrote, "wrote", `session.set(${JSON.stringify(value)})`);
};
$("local").onclick = async () => {
  await chrome.storage.local.set({ note: "from panel" });
  append(wrote, "wrote", `local.set({"note":"from panel"})`);
};
$("remove").onclick = async () => {
  await chrome.storage.session.remove("counter");
  append(wrote, "wrote", `session.remove("counter")`);
};
$("options").onclick = () => chrome.runtime.openOptionsPage();
snapshot();
console.log("DEMO:panel ready");
