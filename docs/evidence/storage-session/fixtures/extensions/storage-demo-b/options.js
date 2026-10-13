document.getElementById("id").textContent = chrome.runtime.id;
const heard = [];
const show = async () => {
  document.getElementById("snapshot").textContent = JSON.stringify(
    await chrome.storage.session.get(null),
    null,
    2
  );
};
watchStorage("options page", (line) => {
  heard.push(line);
  document.getElementById("heard").textContent = heard.join("\n");
  show();
});
show();
console.log("OPTIONS:ready");
