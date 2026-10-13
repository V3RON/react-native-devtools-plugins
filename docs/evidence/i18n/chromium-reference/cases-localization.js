// Which manifest fields and CSS markers Chromium localizes, and how it scans __MSG_ names.
// Recorded in results.txt; src/shared/i18n.js mirrors it.
const en = { hp: { message: "<all_urls>" }, a: { message: "A" }, b: { message: "B" }, a__b: { message: "AB2" }, hello: { message: "Hi" }, nm: { message: "Name EN" }, d: { message: "Desc" }, csp: { message: "script-src 'self' 'unsafe-eval'; object-src 'self'" }, kw: { message: "kwd" } };
const base = { locales: { en }, calls: [] };
module.exports = {
  manifestFieldsA: { ...base, manifest: { name: "__MSG_nm__", short_name: "__MSG_nm__", description: "__MSG_d__", action: { default_title: "__MSG_nm__" }, commands: { c: { description: "__MSG_d__" } }, omnibox: { keyword: "__MSG_kw__" }, version_name: "__MSG_nm__", homepage_url: "https://x/__MSG_nm__", author: "__MSG_nm__" } },
  manifestHostPerms: { ...base, manifest: { name: "n", host_permissions: ["__MSG_hp__"] } },
  manifestPerms: { ...base, manifest: { name: "n", permissions: ["__MSG_hp__"] } },
  manifestCsp: { ...base, manifest: { name: "n", content_security_policy: { extension_pages: "__MSG_csp__" } } },
  manifestWar: { ...base, manifest: { name: "n", web_accessible_resources: [{ resources: ["__MSG_nm__"], matches: ["<all_urls>"] }] } },
  manifestBg: { ...base, manifest: { name: "n", background: { service_worker: "__MSG_nm__" } } },
  manifestOptions: { ...base, manifest: { name: "n", options_ui: { page: "__MSG_nm__" }, devtools_page: "__MSG_nm__" } },
  manifestScan: { ...base, manifest: { name: "__MSG_a____MSG_b__|__MSG_a__b__" } },
  manifestScan2: { ...base, manifest: { name: "__MSG_a__b____MSG_a____MSG_A__" } },
  manifestEmptyName: { ...base, manifest: { name: "x__MSG____y" } },
  cssStops: { ...base, css: { "u.css": "a{b:__MSG_hello__} c{d:__MSG_nope__} e{f:__MSG_hello__}", "k.css": "a{b:__MSG_hello__} c{d:__MSG_@@bidi_dir__} e{f:__MSG_@@extension_id__}", "s.css": "__MSG_a____MSG_b__|__MSG_a__b__", "p.css": "x{y:__msg_hello__ __MSG_HELLO__}" } },
};
