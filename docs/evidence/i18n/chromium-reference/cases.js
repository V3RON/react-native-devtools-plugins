// Cases run against real Chromium by ref-batch.js. Each key is a case; the value is the
// spec ref-case.js turns into an extension (locales + the getMessage calls to make).
const one = (message, extra = {}, calls = [["m"], ["m", ["S1", "S2"]]]) => ({
  locales: { en: { m: { message, ...extra } } },
  calls,
});
const ph = { placeholders: { b: { content: "BB" } } };
const L = (n) => ({ ovr: { message: "ovr " + n }, ["only_" + n]: { message: "only " + n } });
const locales = { en: { ...L("en"), shared: { message: "shared en" } }, en_GB: L("en_GB"), pt: L("pt"), pt_BR: L("pt_BR"), de: L("de"), zh_TW: L("zh_TW"), es_419: L("es_419"), he: L("he"), ar: L("ar"), fr_CA: L("fr_CA") };
const calls = [["ovr"], ["only_en"], ["only_en_GB"], ["only_pt"], ["only_pt_BR"], ["only_de"], ["only_zh_TW"], ["only_es_419"], ["only_he"], ["only_fr_CA"]];
const chain = (lang) => ({ lang, locales, calls, detect: ["Dies ist ein deutscher Satz und ich bin sicher."] });
module.exports = {
  ...require("./cases-localization.js"),
  // $ handling
  dollar5: one("cost $$5"),
  dollar4: one("a $$$$ b"),
  dollar2: one("$$"),
  loneDollar: one("a $ b"),
  trailing: one("100$"),
  unclosed: one("a $b c"),
  nums: one("$1 $2 $10 $0 $9"),
  dollarRuns: { locales: { en: { m1: { message: "$$$1" }, m2: { message: "$$$$1" }, m4: { message: "$$ $" }, m5: { message: "$$$" } } }, calls: [["m1", ["S"]], ["m2", ["S"]], ["m4"], ["m5"]] },
  // placeholders
  phContent: one("x $A$ y", { placeholders: { a: { content: "lit$$eral $1 $a$" } } }),
  phUpper: one("x $a$ y", { placeholders: { A: { content: "up" } } }),
  phDigitsName: one("x $1$ y", { placeholders: { "1": { content: "dig" } } }),
  dd_b: one("a $$b$$ c", ph),
  ddd_b: one("a $$$b$ c", ph),
  b_dd: one("a $b$$ c", ph),
  two_b: one("$b$$b$", ph),
  contentRefsBack: { locales: { en: { m: { message: "$a$", placeholders: { a: { content: "$b$" } } }, b: { message: "x" } } }, calls: [["m"]] },
  msgInMsg: { locales: { en: { m: { message: "x __MSG_n__ y" }, n: { message: "N" } } }, calls: [["m"]] },
  placeholderNameRules: { locales: { en: { m: { message: "v=$a_b1$ $A_B1$", placeholders: { "A_b1": { content: "ok" } } } } }, calls: [["m"]] },
  // names, duplicates, empty
  dupCase: { locales: { en: { M: { message: "upper" }, m: { message: "lower" } } }, calls: [["m"], ["M"]] },
  dupOrder: { locales: { en: { a: { message: "lower" }, A: { message: "UPPER" } } }, calls: [["a"], ["A"]] },
  dupOrder2: { locales: { en: { A: { message: "UPPER" }, a: { message: "lower" } } }, calls: [["a"], ["A"]] },
  emptyMsg: one(""),
  // substitutions and call signatures
  subs: one("[$1|$2|$3]", {}, [["m"], ["m", "a"], ["m", ["a"]], ["m", ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]], ["m", 5], ["m", [1, 2]], ["m", null], ["m", {}], ["m", ["a", null]], ["m", []], ["m", ["$2", "$1"]], ["m", ""], ["m", "a", "b"], [], [""], ["nope"], ["nope", ["a"]], ["M"], [null], [5]]),
  escapeLt: { locales: { en: { m: { message: "a<b>$1" } } }, calls: [["m", ["<i>"]], ["m", ["<i>"], { escapeLt: true }], ["m", null, { escapeLt: true }], ["m", "<i>", {}]] },
  // @@ predefined messages are not variables inside messages (the extension is refused)
  atVar: { locales: { en: { m: { message: "dir=$@@bidi_dir$" } } }, calls: [["m"]] },
  // load-time refusals Chromium makes and this shell relaxes (see docs)
  undefinedVar: one("a $b$ c"),
  badName: { locales: { en: { "a b": { message: "x" } } }, calls: [["a b"]] },
  noMessage: { locales: { en: { m: {} } }, calls: [["m"]] },
  reservedKey: { locales: { en: { "@@ui_locale": { message: "x" } } }, calls: [["@@ui_locale"]] },
  badPlaceholderContent: one("x $a$ y", { placeholders: { a: { content: 5 } } }),
  noDefaultLocale: { locales: { en: { m: { message: "en" } } }, default_locale: "", calls: [["m"]] },
  // manifest + locale chain
  manifestSubst: {
    locales: { en: { nm: { message: "Name EN" }, d: { message: "Desc $1" }, Mixed: { message: "mixed" } } },
    manifest: { name: "__MSG_nm__", description: "pre __MSG_NM__ post __MSG_Mixed__", short_name: "__msg_nm__", action: { default_title: "__MSG_nm__" }, commands: { c: { description: "__MSG_d__" } }, "__MSG_nm__": "key" },
    calls: [],
  },
  detect: { locales: { en: { m: { message: "x" } } }, calls: [], detect: ["", "hello", "12345", "Dies ist ein deutscher Satz und ich bin sicher.", "Ceci est une phrase en français et je suis sûr."] },
  "lang:en-US": chain("en-US"), "lang:en-GB": chain("en-GB"), "lang:pt-BR": chain("pt-BR"), "lang:pt-PT": chain("pt-PT"),
  "lang:de": chain("de"), "lang:de-AT": chain("de-AT"), "lang:zh-TW": chain("zh-TW"), "lang:zh-CN": chain("zh-CN"),
  "lang:es-MX": chain("es-MX"), "lang:he": chain("he"), "lang:ar": chain("ar"), "lang:fr-CA": chain("fr-CA"), "lang:ja": chain("ja"),
};
