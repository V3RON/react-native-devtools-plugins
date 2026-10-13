// Parity with real Chromium: every case in docs/evidence/i18n/chromium-reference/cases.js
// was run through a real headless Chromium 141 (results.txt records what
// chrome.i18n.getMessage answered there). This replays the SAME cases through this
// shell's implementation (buildBundle + getMessage) and demands identical answers.
//
// Not compared, on purpose, because they are host decisions rather than message
// semantics: the accept-language list (Chromium derives it from its own language
// preferences) and getUILanguage for locales Chromium rewrites (es-MX -> es-419 in
// @@ui_locale but not in getUILanguage). The locale handed in is Chromium's own
// `@@ui_locale`, which is what Electron's app.getLocale() reports for the same --lang.
// Cases Chromium REFUSES to load are asserted to be the ones this shell relaxes.
// Regenerate the recording: see the header of docs/evidence/i18n/chromium-reference/results.txt.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const i18n = require("../src/shared/i18n");

const REFERENCE = path.join(__dirname, "..", "docs", "evidence", "i18n", "chromium-reference");
const cases = require(path.join(REFERENCE, "cases.js"));

const recorded = {};
{
  const lines = fs.readFileSync(path.join(REFERENCE, "results.txt"), "utf8").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("== ")) {
      recorded[lines[i].slice(3)] = lines[i + 1];
    }
  }
}

test("every case has a recorded Chromium answer", () => {
  assert.deepStrictEqual(Object.keys(cases).sort(), Object.keys(recorded).sort());
});

// Where this shell answers differently from Chromium, pinned so the gap stays visible
// (docs/features/STORAGE-AND-I18N.md "Known divergences"). Chromium reads the extension's
// locale files from the RAW --lang (`fr-CA` -> _locales/fr_CA) while reporting the
// resolved locale in @@ui_locale (`fr`); this shell only knows the resolved one
// (Electron's app.getLocale()), so a `_locales/fr_CA` folder is not consulted for fr-CA.
const KNOWN_DIVERGENCES = {
  "lang:fr-CA": { '0:["ovr"]': "ovr en", '9:["only_fr_CA"]': "" },
};

const LOAD_REFUSALS = {
  undefinedVar: /Variable \$b\$ used but not defined/,
  badName: /Name of a key "a b" is invalid/,
  noMessage: /There is no "message" element/,
  reservedKey: /Reserved key @@ui_locale/,
  badPlaceholderContent: /Invalid "content" element/,
  noDefaultLocale: /default_locale wasn't specified/,
  atVar: /Variable \$@@bidi_dir\$ used but not defined/,
  // Chromium does not localize these fields, and then rejects the literal marker.
  manifestCsp: /CSP directive 'script-src' must be specified/,
  manifestBg: /Could not load background script/,
  manifestOptions: /Could not load options page '__MSG_nm__'/,
};

for (const [name, spec] of Object.entries(cases)) {
  const line = recorded[name];
  if (line.startsWith("LOAD ERROR")) {
    test(`Chromium refuses "${name}" at load; this shell loads it leniently`, () => {
      assert.match(line, LOAD_REFUSALS[name], `unexpected refusal for ${name}: ${line}`);
      const warnings = [];
      const bundle = i18n.buildBundle({
        extensionId: "x",
        uiLocale: "en_US",
        defaultLocale: spec.default_locale === undefined ? "en" : spec.default_locale,
        catalogs: spec.locales,
        warn: (w) => warnings.push(w),
      });
      assert.ok(bundle, "a bundle is still produced");
      if (spec.manifest) {
        // The refusals above exist BECAUSE Chromium left the marker literal; so does this shell.
        assert.deepStrictEqual(i18n.localizeManifestFields(spec.manifest, bundle), spec.manifest, name);
      }
      for (const [callName, ...rest] of spec.calls) {
        assert.doesNotThrow(() => i18n.getMessage(bundle, [callName, ...rest]));
      }
    });
    continue;
  }

  test(`Chromium parity: ${name}`, () => {
    const answer = JSON.parse(line);
    const uiLocale = answer.ui_locale;
    const bundle = i18n.buildBundle({
      extensionId: "x",
      uiLocale,
      defaultLocale: spec.default_locale === undefined ? "en" : spec.default_locale,
      catalogs: spec.locales,
    });
    spec.calls.forEach((call, index) => {
      const key = `${index}:${JSON.stringify(call)}`;
      // The recorded keys went through JSON, which turns undefined into null.
      const args = call.map((value) => value);
      let ours;
      try {
        ours = i18n.getMessage(bundle, args);
      } catch (error) {
        ours = `THROW ${error.message}`;
      }
      const divergence = KNOWN_DIVERGENCES[name] && KNOWN_DIVERGENCES[name][key];
      assert.strictEqual(
        ours,
        divergence !== undefined ? divergence : answer[key],
        `${name} ${key}${divergence !== undefined ? " (known divergence)" : ""}`
      );
    });
    assert.strictEqual(i18n.getMessage(bundle, ["@@ui_locale"]), answer.ui_locale, `${name} @@ui_locale`);
    assert.deepStrictEqual(
      ["@@bidi_dir", "@@bidi_reversed_dir", "@@bidi_start_edge", "@@bidi_end_edge"].map((n) => i18n.getMessage(bundle, [n])),
      answer.bidi,
      `${name} bidi`
    );
    if (spec.manifest) {
      // The WHOLE manifest Chromium hands back, including the fields it leaves literal.
      const expected = i18n.localizeManifestFields(
        {
          manifest_version: 3,
          name: "case",
          version: "1",
          default_locale: "en",
          background: { service_worker: "sw.js" },
          ...spec.manifest,
        },
        bundle
      );
      expected.current_locale = bundle.uiLocale;
      assert.deepStrictEqual(expected, answer.manifest, `${name} manifest`);
    }
    if (spec.css) {
      // The files as Chromium served them; its random extension id stands in as "x" (our bundle's id).
      assert.deepStrictEqual(
        Object.values(spec.css).map((text) => i18n.localizeCss(text, bundle)),
        answer.css.map((text) => text.replace(/\b[a-p]{32}\b/g, "x")),
        `${name} css`
      );
    }
    if (name.startsWith("lang:")) {
      // The same locale files answer, in the same order, for every UI language Chromium was given.
      assert.strictEqual(answer.ui_locale, bundle.uiLocale);
    }
  });
}
