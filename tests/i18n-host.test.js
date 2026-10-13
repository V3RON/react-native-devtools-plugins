// Host side of chrome.i18n (src/main/i18n-host.js + the manifest reader in
// src/main/extension-server.js): `_locales/` on disk -> bundle, localized manifest and
// CSS. Real files in a temp extensions folder; the UI locale is injected the way
// DEVTOOLS_UI_LOCALE injects it (config.uiLocale), so no Electron is needed.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/main/config");
const extensionServer = require("../src/main/extension-server");
const i18nHost = require("../src/main/i18n-host");
const i18n = require("../src/shared/i18n");

const quiet = () => {
  const warnings = [];
  return { warnings, log: { warn: (m) => warnings.push(m), log() {}, error() {} } };
};

/** An extension folder: { "manifest.json": {...}, "_locales/en/messages.json": {...}, "x.css": "text" } */
const withExtension = (files, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-i18n-"));
  const dir = path.join(root, "ext");
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === "string" ? content : JSON.stringify(content));
  }
  const previousDir = config.extensionsDir;
  const previousLocale = config.uiLocale;
  config.extensionsDir = root;
  try {
    return run(dir);
  } finally {
    config.extensionsDir = previousDir;
    config.uiLocale = previousLocale;
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const catalog = (entries) =>
  Object.fromEntries(Object.entries(entries).map(([name, message]) => [name, { message }]));

const FILES = {
  "manifest.json": {
    name: "__MSG_extName__",
    description: "__MSG_extDesc__",
    default_locale: "en",
    version: "1",
    devtools_page: "devtools.html",
  },
  "_locales/en/messages.json": catalog({ extName: "Name EN", extDesc: "Desc EN", hello: "Hello", onlyEn: "only en" }),
  "_locales/pt/messages.json": catalog({ hello: "Olá" }),
  "_locales/pt_BR/messages.json": catalog({ extName: "Nome BR" }),
  "_locales/ar/messages.json": catalog({ hello: "مرحبا" }),
  "panel.css": "body{direction:__MSG_@@bidi_dir__;content:'__MSG_hello__'}",
};

const bundleFor = (dir, uiLocale, log) =>
  i18nHost.loadBundle({ root: dir, extensionId: "ext", uiLocaleOverride: uiLocale, log });

test("the bundle merges the chain per message: pt-BR -> pt -> en", () => {
  withExtension(FILES, (dir) => {
    const { log, warnings } = quiet();
    const bundle = bundleFor(dir, "pt-BR", log);
    assert.strictEqual(bundle.uiLanguage, "pt-BR");
    assert.strictEqual(bundle.defaultLocale, "en");
    assert.strictEqual(i18n.getMessage(bundle, ["extName"]), "Nome BR", "pt_BR wins");
    assert.strictEqual(i18n.getMessage(bundle, ["hello"]), "Olá", "falls to pt");
    assert.strictEqual(i18n.getMessage(bundle, ["onlyEn"]), "only en", "falls to default_locale");
    assert.deepStrictEqual(warnings, []);
  });
});

test("the bundle is JSON-serialisable and survives the trip the frame makes", () => {
  withExtension(FILES, (dir) => {
    const bundle = JSON.parse(JSON.stringify(bundleFor(dir, "ar", quiet().log)));
    assert.strictEqual(i18n.getMessage(bundle, ["@@bidi_dir"]), "rtl");
    assert.strictEqual(i18n.getMessage(bundle, ["hello"]), "مرحبا");
    assert.strictEqual(i18n.getMessage(bundle, ["@@extension_id"]), "ext");
  });
});

test("a locale directory spelled pt_br is still found; an unreadable catalog is skipped with a warning", () => {
  withExtension(
    {
      "manifest.json": { default_locale: "en" },
      "_locales/en/messages.json": catalog({ a: "en a", b: "en b" }),
      "_locales/pt_br/messages.json": catalog({ a: "pt a" }),
      "_locales/pt/messages.json": "{ not json",
    },
    (dir) => {
      const { log, warnings } = quiet();
      const bundle = bundleFor(dir, "pt-BR", log);
      assert.strictEqual(i18n.getMessage(bundle, ["a"]), "pt a");
      assert.strictEqual(i18n.getMessage(bundle, ["b"]), "en b");
      assert.strictEqual(warnings.length, 1);
      assert.match(warnings[0], /_locales\/pt\/messages\.json unreadable/);
    }
  );
});

test("a BOM in messages.json and manifest.json is tolerated", () => {
  withExtension(
    {
      "manifest.json": "﻿" + JSON.stringify({ name: "__MSG_n__", default_locale: "en" }),
      "_locales/en/messages.json": "﻿" + JSON.stringify(catalog({ n: "Named" })),
    },
    () => {
      assert.strictEqual(extensionServer.loadManifest("ext").name, "Named");
    }
  );
});

test("no _locales: the bundle still answers the predefined messages, everything else is empty", () => {
  withExtension({ "manifest.json": { name: "plain" } }, (dir) => {
    const { log, warnings } = quiet();
    const bundle = bundleFor(dir, "de", log);
    assert.strictEqual(i18n.getMessage(bundle, ["@@ui_locale"]), "de");
    assert.strictEqual(i18n.getMessage(bundle, ["anything"]), "");
    assert.deepStrictEqual(warnings, []);
  });
});

test("_locales without a usable default_locale is reported, not refused", () => {
  withExtension(
    { "manifest.json": { name: "x" }, "_locales/en/messages.json": catalog({ a: "A" }) },
    (dir) => {
      const { log, warnings } = quiet();
      const bundle = bundleFor(dir, "en-US", log);
      assert.strictEqual(i18n.getMessage(bundle, ["a"]), "A", "the UI locale chain still answers");
      assert.match(warnings.join("\n"), /no valid default_locale/);
    }
  );
  withExtension(
    { "manifest.json": { default_locale: "fr" }, "_locales/en/messages.json": catalog({ a: "A" }) },
    (dir) => {
      const { log, warnings } = quiet();
      bundleFor(dir, "en-US", log);
      assert.match(warnings.join("\n"), /default_locale "fr" has no _locales\/fr/);
    }
  );
});

test("a messages.json that is not a regular file is refused instead of read", () => {
  withExtension(FILES, (dir) => {
    fs.rmSync(path.join(dir, "_locales/pt/messages.json"));
    fs.mkdirSync(path.join(dir, "_locales/pt/messages.json"));
    const { log, warnings } = quiet();
    const bundle = bundleFor(dir, "pt-BR", log);
    assert.strictEqual(i18n.getMessage(bundle, ["hello"]), "Hello", "pt unreadable: falls to en");
    assert.ok(warnings.some((w) => /_locales\/pt\/messages\.json unreadable/.test(w)));
  });
});

test("loadManifest localizes name/description for every host reader, in the configured UI locale", () => {
  withExtension(FILES, () => {
    config.uiLocale = "pt-BR";
    const manifest = extensionServer.loadManifest("ext");
    assert.strictEqual(manifest.name, "Nome BR");
    assert.strictEqual(manifest.description, "Desc EN", "per-message fallback reaches the manifest too");
    assert.strictEqual(manifest.current_locale, "pt_BR", "Chrome adds current_locale");
    assert.strictEqual(manifest.default_locale, "en");
    config.uiLocale = "ja";
    assert.strictEqual(extensionServer.loadManifest("ext").name, "Name EN");
  });
});

test("scanExtensions lists the localized name (what the panel list shows)", () => {
  withExtension(FILES, () => {
    const { scanExtensions } = require("../src/main/extensions");
    config.uiLocale = "pt-BR";
    assert.deepStrictEqual(
      scanExtensions().map((entry) => entry.name),
      ["Nome BR"]
    );
  });
});

test("a manifest without __MSG_ or default_locale is returned untouched (same object content)", () => {
  withExtension({ "manifest.json": { name: "Plain", version: "1" } }, () => {
    assert.deepStrictEqual(extensionServer.loadManifest("ext"), { name: "Plain", version: "1" });
  });
});

test("an unknown __MSG_ name is left as written; a broken catalog never breaks the manifest", () => {
  withExtension(
    {
      "manifest.json": { name: "__MSG_missing__", default_locale: "en" },
      "_locales/en/messages.json": "{ nope",
    },
    () => {
      assert.strictEqual(extensionServer.loadManifest("ext").name, "__MSG_missing__");
    }
  );
});

test("CSS localization: only files that use the marker are rewritten", () => {
  withExtension(FILES, (dir) => {
    const text = fs.readFileSync(path.join(dir, "panel.css"), "utf8");
    const localized = i18nHost.localizeCssFile({ text, root: dir, extensionId: "ext", uiLocaleOverride: "ar", log: quiet().log });
    assert.strictEqual(localized, "body{direction:rtl;content:'مرحبا'}");
    assert.strictEqual(
      i18nHost.localizeCssFile({ text: "a{b:c}", root: dir, extensionId: "ext", uiLocaleOverride: "ar", log: quiet().log }),
      "a{b:c}"
    );
  });
});

test("the bundle path is reserved: no file can be served under it", () => {
  assert.strictEqual(extensionServer.resolveExtensionFile("ext", extensionServer.I18N_BUNDLE_PATH), null);
  assert.strictEqual(extensionServer.resolveExtensionFile("ext", `/${extensionServer.I18N_BUNDLE_PATH}`), null);
  assert.strictEqual(extensionServer.I18N_BUNDLE_PATH, require("../src/shared/protocol").I18N_BUNDLE_PATH);
});

test("systemLocale: the override wins, and outside Electron it degrades to en-US", () => {
  assert.strictEqual(i18nHost.systemLocale("de").uiLocale, "de");
  const fallback = i18nHost.systemLocale("");
  assert.strictEqual(fallback.uiLocale, "en-US");
  assert.deepStrictEqual(fallback.preferredLanguages, []);
});

test("the shipped sample extension is fully translated where it claims to be", () => {
  const dir = path.join(__dirname, "..", "extensions", "sample-extension");
  const read = (locale) => JSON.parse(fs.readFileSync(path.join(dir, "_locales", locale, "messages.json"), "utf8"));
  const en = read("en");
  for (const locale of ["pt_BR", "de", "ar"]) {
    const other = read(locale);
    for (const name of Object.keys(other)) {
      assert.ok(name in en, `${locale} defines ${name}, which the default locale lacks`);
    }
    assert.ok(other.heading && other.greeting, `${locale} translates the panel`);
  }
  const bundle = i18nHost.loadBundle({ root: dir, extensionId: "sample-extension", uiLocaleOverride: "pt-BR", log: quiet().log });
  assert.strictEqual(i18n.getMessage(bundle, ["greeting", ["Ada", "3"]]), "Olá, Ada! Você tem 3 mensagens novas.");
  assert.strictEqual(i18n.getMessage(bundle, ["price"]), "Custa R$5 por mês");
  assert.strictEqual(i18n.getMessage(bundle, ["onlyDefault"]), "(this line exists only in the default locale, en)");
});

test("the frame's only synchronous read is the bundle XHR to its own origin; no sendSync anywhere", () => {
  const preload = fs
    .readFileSync(path.join(__dirname, "..", "src", "preload", "extension-frame.js"), "utf8")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/sendSync/.test(preload), "no sendSync in the extension-frame preload");
  assert.strictEqual((preload.match(/new XMLHttpRequest\(/g) || []).length, 1, "exactly one XMLHttpRequest");
  assert.ok(
    preload.includes("`${window.location.origin}/${I18N_BUNDLE_PATH}`"),
    "and it targets the frame's own origin + the reserved bundle path"
  );
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "ipc.js"), "utf8");
  assert.ok(!/sendSync/i.test(ipc.replace(/\/\/.*$/gm, "")), "no synchronous channel in the channel table");
});
