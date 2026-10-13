// Shared by every showcase panel: adopt the DevTools theme and follow live changes.
//
// Chrome's real API: `chrome.devtools.panels.themeName` ("default" or "dark") for the
// current theme and `chrome.devtools.panels.setThemeChangeHandler(cb)` for changes
// (there is no `themeChanged` event in Chrome). Where a host provides neither, the page
// follows the OS colour scheme so it stays readable.
(() => {
  const panels = typeof chrome !== "undefined" && chrome.devtools && chrome.devtools.panels;
  let current = null;
  const apply = (name) => {
    const theme = name === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    current = theme;
    return theme;
  };
  /** @returns {{name: string|undefined, hasHook: boolean, fallback: boolean}} */
  const init = (onChange) => {
    const name = panels ? panels.themeName : undefined;
    const fallback = name === undefined;
    if (fallback) {
      const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
      apply(dark ? "dark" : "default");
    } else {
      apply(name);
    }
    const hasHook = !!panels && typeof panels.setThemeChangeHandler === "function";
    if (hasHook) {
      panels.setThemeChangeHandler((n) => {
        const before = current;
        if (apply(n) !== before && onChange) onChange(n); // Chrome can notify twice
      });
    }
    return { name, hasHook, fallback };
  };
  window.ShowcaseTheme = { init };
})();
