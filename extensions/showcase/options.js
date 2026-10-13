// options_ui page: one storage.sync setting + an i18n greeting.
const KEY = "showcase:name";
const $ = (id) => document.getElementById(id);
const t = (k, subs) => (chrome.i18n ? chrome.i18n.getMessage(k, subs) : "") || "";

const render = (name) => {
  const text = t("greeting", name || "stranger");
  $("greeting").textContent = text || "Hello, " + (name || "stranger") + "!";
};

if (t("optionsTitle")) $("title").textContent = t("optionsTitle");

chrome.storage.sync.get(KEY, (got) => {
  const name = (got && got[KEY]) || "";
  $("name").value = name;
  render(name);
});

$("save").addEventListener("click", () => {
  const name = $("name").value.trim();
  chrome.storage.sync.set({ [KEY]: name }, () => {
    $("status").textContent = chrome.runtime.lastError
      ? "Save failed: " + chrome.runtime.lastError.message
      : "Saved to storage.sync";
    render(name);
  });
});
