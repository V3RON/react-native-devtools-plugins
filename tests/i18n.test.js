// chrome.i18n message semantics (src/shared/i18n.js, src/chrome-shim/i18n.js).
//
// Every expectation tagged "Chromium 141:" was measured by loading a fixture extension
// into a real headless Chromium 141 (--load-extension) and calling chrome.i18n there;
// the fixtures and the driver are in docs/evidence/i18n/chromium-reference/. The rest
// follows from those measurements.
const test = require("node:test");
const assert = require("node:assert");
const i18n = require("../src/shared/i18n");
const { createI18n } = require("../src/chrome-shim/i18n");

const bundleOf = (catalogs, { ui = "en_US", def = "en", id = "ext", preferred = [] } = {}) =>
  i18n.buildBundle({
    extensionId: id,
    uiLocale: ui,
    defaultLocale: def,
    catalogs,
    preferredLanguages: preferred,
  });
const msg = (message, extra = {}) => ({ message, ...extra });
const one = (message, extra) => bundleOf({ en: { m: msg(message, extra) } });
const get = (bundle, ...args) => i18n.getMessage(bundle, args);

test("normalizeLocale accepts hyphen/underscore spellings and rejects garbage", () => {
  assert.strictEqual(i18n.normalizeLocale("pt-BR"), "pt_BR");
  assert.strictEqual(i18n.normalizeLocale("pt_br"), "pt_BR");
  assert.strictEqual(i18n.normalizeLocale("EN"), "en");
  assert.strictEqual(i18n.normalizeLocale("es-419"), "es_419");
  assert.strictEqual(i18n.normalizeLocale("zh-hant-tw"), "zh_Hant_TW");
  assert.strictEqual(i18n.normalizeLocale("../etc"), "");
  assert.strictEqual(i18n.normalizeLocale(""), "");
  assert.strictEqual(i18n.normalizeLocale(undefined), "");
});

test("locale chain: specific -> language -> default_locale, no duplicates", () => {
  assert.deepStrictEqual(i18n.localeChain("pt_BR", "en"), ["pt_BR", "pt", "en"]);
  assert.deepStrictEqual(i18n.localeChain("pt-PT", "pt"), ["pt_PT", "pt"]);
  assert.deepStrictEqual(i18n.localeChain("en_US", "en"), ["en_US", "en"]);
  assert.deepStrictEqual(i18n.localeChain("de", "en"), ["de", "en"]);
  assert.deepStrictEqual(i18n.localeChain("zh_Hant_TW", "en"), ["zh_Hant_TW", "zh_Hant", "zh", "en"]);
  assert.deepStrictEqual(i18n.localeChain("fr", ""), ["fr"]);
});

test("Chromium 141: fallback is PER MESSAGE, most specific locale first", () => {
  const catalogs = {
    en: { ovr: msg("ovr en"), onlyen: msg("only en") },
    pt: { ovr: msg("ovr pt"), onlypt: msg("only pt") },
    pt_BR: { ovr: msg("ovr pt_BR") },
    de: { ovr: msg("ovr de") },
  };
  const ptBR = bundleOf(catalogs, { ui: "pt_BR" });
  assert.strictEqual(get(ptBR, "ovr"), "ovr pt_BR");
  assert.strictEqual(get(ptBR, "onlypt"), "only pt");
  assert.strictEqual(get(ptBR, "onlyen"), "only en");
  const ptPT = bundleOf(catalogs, { ui: "pt_PT" });
  assert.strictEqual(get(ptPT, "ovr"), "ovr pt", "pt_PT has no folder: pt answers");
  const ja = bundleOf(catalogs, { ui: "ja" });
  assert.strictEqual(get(ja, "ovr"), "ovr en", "no ja folder: default_locale answers");
});

test("Chromium 141: message names are case-insensitive; with duplicates the sorted-last key wins", () => {
  const bundle = bundleOf({ en: { Hello: msg("hi"), UPPER: msg("u") } });
  assert.strictEqual(get(bundle, "hello"), "hi");
  assert.strictEqual(get(bundle, "HELLO"), "hi");
  assert.strictEqual(get(bundle, "upper"), "u");
  // "A" sorts before "a", so "a" wins whichever order the file lists them in.
  assert.strictEqual(get(bundleOf({ en: { a: msg("lower"), A: msg("UPPER") } }), "A"), "lower");
  assert.strictEqual(get(bundleOf({ en: { A: msg("UPPER"), a: msg("lower") } }), "a"), "lower");
});

test("Chromium 141: unknown names and the empty name give the empty string", () => {
  const bundle = one("x");
  assert.strictEqual(get(bundle, "nope"), "");
  assert.strictEqual(get(bundle, "nope", ["a"]), "");
  assert.strictEqual(get(bundle, ""), "");
  assert.strictEqual(get(bundle, "@@nope"), "");
  assert.strictEqual(get(bundle, "__proto__"), "");
  assert.strictEqual(get(bundle, "constructor"), "");
  assert.strictEqual(get(one(""), "m"), "", "an empty message is a message");
});

test("Chromium 141: a bad call throws Chrome's signature TypeError", () => {
  const bundle = one("x");
  for (const args of [[], [null], [5], [undefined], ["m", "a", "b"], ["m", "a", null], ["m", "a", 3], ["m", "a", {}, "x"]]) {
    assert.throws(() => i18n.getMessage(bundle, args), (error) => {
      assert.ok(error instanceof TypeError, JSON.stringify(args));
      assert.match(error.message, /i18n\.getMessage\(string messageName, optional any substitutions, optional object options\): No matching signature/);
      return true;
    });
  }
  assert.doesNotThrow(() => i18n.getMessage(bundle, ["m", undefined, {}]));
});

test("Chromium 141: $1..$9 substitutions; strings, arrays, missing ones are empty", () => {
  const bundle = one("[$1|$2|$3]");
  assert.strictEqual(get(bundle, "m"), "[||]");
  assert.strictEqual(get(bundle, "m", "a"), "[a||]");
  assert.strictEqual(get(bundle, "m", ["a"]), "[a||]");
  assert.strictEqual(get(bundle, "m", ["a", "b", "c", "d"]), "[a|b|c]");
  assert.strictEqual(get(bundle, "m", []), "[||]");
  assert.strictEqual(get(bundle, "m", ""), "[||]");
  // Array members are stringified, a bare non-string is ignored.
  assert.strictEqual(get(bundle, "m", [1, 2]), "[1|2|]");
  assert.strictEqual(get(bundle, "m", ["a", null]), "[a|null|]");
  assert.strictEqual(get(bundle, "m", 5), "[||]");
  assert.strictEqual(get(bundle, "m", null), "[||]");
  assert.strictEqual(get(bundle, "m", undefined), "[||]");
  assert.strictEqual(get(bundle, "m", {}), "[||]");
  // Substituted text is not scanned again.
  assert.strictEqual(get(bundle, "m", ["$2", "$1"]), "[$2|$1|]");
});

test("Chromium 141: more than nine substitutions returns undefined", () => {
  const bundle = one("$1");
  assert.strictEqual(get(bundle, "m", ["1", "2", "3", "4", "5", "6", "7", "8", "9"]), "1");
  assert.strictEqual(get(bundle, "m", ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]), undefined);
});

test("Chromium 141: $10 is $1 followed by a literal 0; $0 is dropped", () => {
  const bundle = one("$1 $2 $10 $0 $9");
  assert.strictEqual(get(bundle, "m"), "  0  ");
  assert.strictEqual(get(bundle, "m", ["S1", "S2"]), "S1 S2 S10  ");
});

test("Chromium 141: a run of k >= 2 dollars becomes k-1 dollars", () => {
  assert.strictEqual(get(one("cost $$5"), "m"), "cost $5");
  assert.strictEqual(get(one("$$"), "m"), "$");
  assert.strictEqual(get(one("a $$$$ b"), "m"), "a $$$ b");
  assert.strictEqual(get(one("$$$"), "m"), "$$");
  assert.strictEqual(get(one("$$$1"), "m", ["S"]), "$$1", "the digit after a run is literal");
  assert.strictEqual(get(one("$$$$1"), "m", ["S"]), "$$$1");
});

test("Chromium 141: any other `$x` is dropped together with x (a lone or trailing $ vanishes)", () => {
  assert.strictEqual(get(one("a $ b"), "m"), "a b");
  assert.strictEqual(get(one("100$"), "m"), "100");
  assert.strictEqual(get(one("a $b c"), "m"), "a  c");
  assert.strictEqual(get(one("$$ $"), "m"), "$ ");
});

test("Chromium 141: $placeholder$ takes its content, names are case-insensitive", () => {
  const hello = one("Hello $USER$, you have $count$ items ($1)", {
    placeholders: { user: { content: "$1" }, Count: { content: "$2" } },
  });
  assert.strictEqual(get(hello, "m", ["A", "B"]), "Hello A, you have B items (A)");
  assert.strictEqual(get(hello, "m", ["A"]), "Hello A, you have  items (A)");
  assert.strictEqual(get(hello, "m"), "Hello , you have  items ()");
  assert.strictEqual(get(one("x $a$ y", { placeholders: { A: { content: "up" } } }), "m"), "x up y");
  assert.strictEqual(get(one("x $1$ y", { placeholders: { 1: { content: "dig" } } }), "m"), "x dig y");
  assert.strictEqual(get(one("$b$$b$", { placeholders: { b: { content: "BB" } } }), "m"), "BBBB");
});

test("Chromium 141: placeholder content is inserted once (not rescanned), then stage 2 runs on it", () => {
  const bundle = one("x $A$ y", { placeholders: { a: { content: "lit$$eral $1 $a$" } } });
  assert.strictEqual(get(bundle, "m", ["S1", "S2"]), "x lit$eral S1 y");
  const refs = bundleOf({
    en: { m: msg("$a$", { placeholders: { a: { content: "$b$" } } }), b: msg("x") },
  });
  assert.strictEqual(get(refs, "m"), "", "$b$ inside content is not a variable; stage 2 drops it");
});

test("Chromium 141: `$$` next to a variable is read left to right", () => {
  const ph = { placeholders: { b: { content: "BB" } } };
  assert.strictEqual(get(one("a $$b$$ c", ph), "m"), "a Bc");
  assert.strictEqual(get(one("a $$$b$ c", ph), "m"), "a $BB c");
  assert.strictEqual(get(one("a $b$$ c", ph), "m"), "a BBc");
});

test("Chromium 141: __MSG_ inside a message is NOT substituted; @@ names are not variables", () => {
  const bundle = bundleOf({ en: { m: msg("x __MSG_n__ y"), n: msg("N") } });
  assert.strictEqual(get(bundle, "m"), "x __MSG_n__ y");
});

test("escapeLt escapes `<` in the message text only, not in substitutions", () => {
  const bundle = one("a<b>$1");
  assert.strictEqual(get(bundle, "m", ["<i>"]), "a<b><i>");
  assert.strictEqual(get(bundle, "m", ["<i>"], { escapeLt: true }), "a&lt;b><i>");
  assert.strictEqual(get(bundle, "m", undefined, { escapeLt: true }), "a&lt;b>");
  assert.strictEqual(get(bundle, "m", "<i>", {}), "a<b><i>");
});

test("Chromium 141: predefined @@ messages (case-insensitive), LTR", () => {
  const bundle = bundleOf({}, { ui: "en_US", id: "abc" });
  assert.strictEqual(get(bundle, "@@extension_id"), "abc");
  assert.strictEqual(get(bundle, "@@ui_locale"), "en_US");
  assert.strictEqual(get(bundle, "@@UI_LOCALE"), "en_US");
  assert.deepStrictEqual(
    ["@@bidi_dir", "@@bidi_reversed_dir", "@@bidi_start_edge", "@@bidi_end_edge"].map((n) => get(bundle, n)),
    ["ltr", "rtl", "left", "right"]
  );
});

test("Chromium 141: predefined @@bidi_* flip for right-to-left locales (he, ar)", () => {
  for (const ui of ["he", "ar", "fa", "ur"]) {
    const bundle = bundleOf({}, { ui });
    assert.deepStrictEqual(
      ["@@bidi_dir", "@@bidi_reversed_dir", "@@bidi_start_edge", "@@bidi_end_edge"].map((n) => get(bundle, n)),
      ["rtl", "ltr", "right", "left"],
      ui
    );
  }
  assert.strictEqual(get(bundleOf({}, { ui: "ar_EG" }), "@@bidi_dir"), "rtl");
});

test("Chromium 141: getUILanguage is the BCP 47 tag, @@ui_locale the underscore form", () => {
  const bundle = bundleOf({}, { ui: "pt-BR" });
  assert.strictEqual(bundle.uiLanguage, "pt-BR");
  assert.strictEqual(bundle.uiLocale, "pt_BR");
  assert.strictEqual(bundleOf({}, { ui: "de" }).uiLanguage, "de");
  assert.strictEqual(bundleOf({}, { ui: "garbage/../" }).uiLanguage, "en-US", "an unusable locale degrades to en-US");
});

test("Chromium 141: accept languages = locale, its language, then English (pt-BR -> pt-BR, pt, en-US, en)", () => {
  assert.deepStrictEqual(i18n.acceptLanguagesFor("pt_BR", []), ["pt-BR", "pt", "en-US", "en"]);
  assert.deepStrictEqual(i18n.acceptLanguagesFor("en_US", []), ["en-US", "en"]);
  assert.deepStrictEqual(i18n.acceptLanguagesFor("en_GB", []), ["en-GB", "en"], "English is already there");
  assert.deepStrictEqual(i18n.acceptLanguagesFor("de", ["de-DE", "en-GB"]), ["de", "de-DE", "en-GB", "en"]);
});

test("catalog hygiene: invalid entries are skipped and reported, valid ones kept", () => {
  const warnings = [];
  const bundle = i18n.buildBundle({
    extensionId: "e",
    uiLocale: "en_US",
    defaultLocale: "en",
    catalogs: {
      en: {
        ok: msg("fine"),
        "a b": msg("space in name"),
        "@@ui_locale": msg("reserved"),
        nomessage: {},
        numeric: { message: 5 },
        badph: msg("$p$", { placeholders: { p: { content: 5 } } }),
        undefinedVar: msg("a $zz$ b"),
      },
    },
    warn: (w) => warnings.push(w),
  });
  assert.strictEqual(get(bundle, "ok"), "fine");
  assert.strictEqual(get(bundle, "a b"), "");
  assert.strictEqual(get(bundle, "@@ui_locale"), "en_US", "the catalog cannot redefine a predefined message");
  assert.strictEqual(get(bundle, "nomessage"), "");
  assert.strictEqual(get(bundle, "numeric"), "");
  assert.strictEqual(get(bundle, "badph"), "");
  assert.strictEqual(get(bundle, "undefinedVar"), "a  b", "an undefined variable is empty (Chrome refuses the extension)");
  assert.strictEqual(warnings.length, 6, warnings.join("\n"));
  assert.ok(warnings.every((w) => w.startsWith("_locales/en")));
});

test("a catalog that is not an object is ignored with a warning", () => {
  const warnings = [];
  for (const bad of [null, [], "x", 5]) {
    const compiled = i18n.compileCatalog(bad, { warn: (w) => warnings.push(w), locale: "en" });
    assert.deepStrictEqual(compiled, {});
  }
  assert.strictEqual(warnings.length, 4);
});

test("Chromium 141: only Chromium's own manifest fields are localized; prefix case-sensitive, name not, keys untouched", () => {
  const bundle = bundleOf({ en: { nm: msg("Name EN"), d: msg("Desc $1"), Mixed: msg("mixed"), kw: msg("kwd") } });
  const manifest = {
    name: "__MSG_nm__",
    description: "pre __MSG_NM__ post __MSG_Mixed__",
    short_name: "__msg_nm__",
    action: { default_title: "__MSG_nm__", default_popup: "__MSG_nm__" },
    commands: { c: { description: "__MSG_d__", suggested_key: "__MSG_nm__" } },
    omnibox: { keyword: "__MSG_kw__" },
    __MSG_nm__: "key",
  };
  assert.deepStrictEqual(i18n.localizeManifestFields(manifest, bundle), {
    name: "Name EN",
    description: "pre Name EN post mixed",
    short_name: "__msg_nm__",
    action: { default_title: "Name EN", default_popup: "__MSG_nm__" },
    commands: { c: { description: "Desc $1", suggested_key: "__MSG_nm__" } },
    omnibox: { keyword: "kwd" },
    __MSG_nm__: "key",
  });
});

test("Chromium 141: capabilities never depend on the UI language (host_permissions, CSP, scripts, paths stay literal)", () => {
  const bundle = bundleOf({ en: { hp: msg("<all_urls>"), p: msg("tabs"), csp: msg("script-src *"), f: msg("evil.js") } });
  const manifest = {
    name: "n",
    permissions: ["__MSG_p__"],
    host_permissions: ["__MSG_hp__"],
    content_security_policy: { extension_pages: "__MSG_csp__" },
    content_scripts: [{ matches: ["__MSG_hp__"], js: ["__MSG_f__"] }],
    background: { service_worker: "__MSG_f__" },
    web_accessible_resources: [{ resources: ["__MSG_f__"], matches: ["__MSG_hp__"] }],
    options_ui: { page: "__MSG_f__" },
    devtools_page: "__MSG_f__",
    homepage_url: "https://x/__MSG_f__",
    version_name: "__MSG_f__",
  };
  assert.deepStrictEqual(i18n.localizeManifestFields(manifest, bundle), manifest);
});

test("Chromium 141: a name ends at the FIRST `__`, not the last (not a greedy match)", () => {
  const bundle = bundleOf({ en: { a: msg("A"), b: msg("B"), a__b: msg("AB2") } });
  const name = (text) => i18n.localizeManifestFields({ name: text }, bundle).name;
  assert.strictEqual(name("__MSG_a____MSG_b__|__MSG_a__b__"), "AB|Ab__");
  assert.strictEqual(name("__MSG_a__b____MSG_a____MSG_A__"), "Ab__AA");
  assert.strictEqual(name("x__MSG____y"), "x__MSG____y", "an empty name is no marker");
  assert.strictEqual(name("__MSG_a"), "__MSG_a", "an unterminated marker is literal");
  assert.strictEqual(name("__MSG_unknown__ __MSG_a__"), "__MSG_unknown__ A", "manifest: unknown stays, scan continues");
});

test("CSS: __MSG_x__ and __MSG_@@bidi_dir__ are substituted; the first unknown name stops the file (Chromium 141)", () => {
  const rtl = bundleOf({ en: { c: msg("red") } }, { ui: "ar" });
  assert.strictEqual(
    i18n.localizeCss("body{direction:__MSG_@@bidi_dir__;color:__MSG_C__;float:__MSG_@@bidi_start_edge__}", rtl),
    "body{direction:rtl;color:red;float:right}"
  );
  assert.strictEqual(
    i18n.localizeCss("a{b:__MSG_c__} x{y:__MSG_nope__} z{w:__MSG_c__ __MSG_@@bidi_dir__}", rtl),
    "a{b:red} x{y:__MSG_nope__} z{w:__MSG_c__ __MSG_@@bidi_dir__}"
  );
});

// ── the shim object (what an extension actually sees) ───────────────────────────────────

test("shim: getMessage/getUILanguage are synchronous and lazy; the bundle loads once", () => {
  let loads = 0;
  const api = createI18n({
    extensionId: "ext",
    loadBundle: () => {
      loads += 1;
      return bundleOf({ en: { hi: msg("Hello $1", {}) } }, { id: "ext" });
    },
  });
  assert.strictEqual(loads, 0, "nothing is read until the first call");
  assert.strictEqual(api.getMessage("hi", "Ada"), "Hello Ada");
  assert.strictEqual(api.getUILanguage(), "en-US");
  assert.strictEqual(api.getMessage("@@extension_id"), "ext");
  assert.strictEqual(loads, 1);
});

test("shim: getAcceptLanguages answers by promise and by callback, with a copy", async () => {
  const api = createI18n({ extensionId: "e", loadBundle: () => bundleOf({}, { ui: "pt_BR" }) });
  assert.deepStrictEqual(await api.getAcceptLanguages(), ["pt-BR", "pt", "en-US", "en"]);
  const viaCallback = await new Promise((resolve) => {
    const returned = api.getAcceptLanguages(resolve);
    assert.strictEqual(returned, undefined, "callback style returns nothing");
  });
  assert.deepStrictEqual(viaCallback, ["pt-BR", "pt", "en-US", "en"]);
  const list = await api.getAcceptLanguages();
  list.push("zz");
  assert.ok(!(await api.getAcceptLanguages()).includes("zz"), "callers cannot mutate the shim's list");
});

test("shim: detectLanguage is an honest 'undetermined' (promise and callback), and validates its input", async () => {
  const api = createI18n({ extensionId: "e", loadBundle: () => null });
  assert.deepStrictEqual(await api.detectLanguage("Dies ist ein deutscher Satz"), { isReliable: false, languages: [] });
  const viaCallback = await new Promise((resolve) => api.detectLanguage("", resolve));
  assert.deepStrictEqual(viaCallback, { isReliable: false, languages: [] });
  await assert.rejects(() => api.detectLanguage(5), /detectLanguage\(string text/);
});

test("shim: no bundle (loader absent, throwing, or empty) degrades to Chrome's no-catalog answers", () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const failing = createI18n({
    extensionId: "e",
    loadBundle: () => {
      throw new Error("host answered 404");
    },
    logger,
  });
  assert.strictEqual(failing.getMessage("anything"), "");
  assert.strictEqual(failing.getMessage("@@extension_id"), "e");
  assert.strictEqual(failing.getUILanguage(), "en-US");
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /host answered 404/);
  assert.strictEqual(createI18n({ extensionId: "e" }).getMessage("x"), "");
});

test("shim is mounted on the chrome namespace, ungated (no permission is needed for i18n)", () => {
  const { createChromeNamespace } = require("../src/chrome-shim");
  const { createExtensionStorage, createMemoryBackend } = require("../src/chrome-shim/storage");
  const { createGrantGate } = require("../src/shared/permissions");
  const gate = createGrantGate(() => ({}));
  gate.manifestLoaded();
  const chrome = createChromeNamespace({
    extensionId: "mounted",
    loadI18nBundle: () => bundleOf({ en: { x: msg("ex") } }, { id: "mounted" }),
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  assert.strictEqual(chrome.i18n.getMessage("x"), "ex");
  assert.strictEqual(chrome.i18n.getMessage("@@extension_id"), "mounted");
});
