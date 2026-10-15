// Symlink containment for the `rozenite://` file server (GitHub issue #21, finding
// F1 of docs/SECURITY-PLATFORM.md §3.2).
//
// The guard used to compare PATH TEXT (`path.resolve` + a `root + sep` prefix test)
// while every read that follows it — `fs.statSync`, `net.fetch(file://)` — FOLLOWS
// symlinks. So one link planted inside an extension folder made that folder's own
// page read any file the developer can read, with a plain `fetch("stolen")`: no IPC,
// no permission, no prompt. The fix compares the REALPATHS of the root and the
// target; these tests are the ways that rule could be wrong, each with a real link on
// disk. Every caller that asks the guard for a path inherits it — the scanners'
// manifest reads, `src/main/content-scripts.js`, and the panel/options/registration
// gates in `src/main/ipc.js`. `src/main/i18n-host.js` does NOT ask the guard: it
// builds its OWN paths under the root, so it applies the same rule to them itself,
// and that second copy is what makes the claim hold for every read there is (suite 6).
//
//   1. a link that escapes the folder is REFUSED — a file link, a directory link, and
//      an escape reached by joining segments on AFTER the link was followed;
//   2. a link that stays inside the folder still RESOLVES — containment is about where
//      a path lands, not about which directory entries happen to be links;
//   3. a symlinked extension ROOT is refused by the server AND skipped by the scan:
//      the two containment layers agree on what an extension is, and that agreement is
//      stated in the guard's docblock (src/main/extension-server.js);
//   4. the RESERVED inner paths keep their rules in both directions, and the main-side
//      reads they exist for still work — the background bootstrap's script and the
//      chrome.i18n bundle, which read the root and `_locales/` rather than a
//      page-served file, so a realpath change could have broken them silently;
//   5. a path that simply does not exist is still reported as MISSING, not REFUSED
//      (the distinction `src/main/content-scripts.js` shows the developer);
//   6. the message-bundle and CSS-localisation reads — which build their OWN paths
//      under the root (`_locales/<locale>/messages.json`) and therefore never pass a
//      page-facing resolver — are contained by the same rule, inside
//      `src/main/i18n-host.js`. That is what makes the claim above ("every caller
//      inherits it") true rather than aspirational.
//
// The folder is a temp dir and `config.extensionsDir` is redirected at CALL time — the
// technique tests/extensions-scan.test.js and tests/content-scripts-registry.test.js
// use, so production code stays unchanged and no child process is needed. What a unit
// test cannot show — that the refusal is what a real renderer's `fetch()` gets over
// `rozenite://` — is asserted in a real Electron process by
// tests/background-worker-electron.test.js ("a background context cannot be claimed
// from a page").
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../src/main/config");
const {
  BACKGROUND_BOOTSTRAP_PATH,
  I18N_BUNDLE_PATH,
  loadManifest,
  resolveExtensionFile,
  resolveInsideExtension,
} = require("../src/main/extension-server");
const {
  extensionFolders,
  scanExtensions,
  scanBackgroundExtensions,
} = require("../src/main/extensions");
const i18nHost = require("../src/main/i18n-host");
const i18n = require("../src/shared/i18n");

const REAL_EXTENSIONS_DIR = config.extensionsDir;

/** The path the guard is expected to hand back for a contained name that exists. */
const real = (filePath) => fs.realpathSync(filePath);

/** A log that collects warnings instead of printing them (as tests/i18n-host.test.js does). */
const quiet = () => {
  const warnings = [];
  return { warnings, log: { warn: (message) => warnings.push(message), log() {}, error() {} } };
};

// Unprivileged symlink creation works on macOS and Linux; on Windows it needs
// developer mode or elevation. A run that cannot create a link cannot test this rule
// at all, so it says so instead of passing vacuously — the same shape the Electron
// suites use when the binary is missing.
const symlinksAvailable = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-symlink-probe-"));
  try {
    fs.mkdirSync(path.join(probe, "target"));
    fs.symlinkSync("target", path.join(probe, "link"));
    return true;
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS", "EXDEV"].includes(error && error.code)) {
      throw error;
    }
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
})();
const suite = symlinksAvailable ? test : test.skip;

const SECRET = "the-developer-private-key";

/** Files that live OUTSIDE every extension folder — the thing F1 used to hand out. */
const OUTSIDE = {
  "outside/id_ed25519": SECRET,
  "outside/dir/inside-dir.txt": `${SECRET}, reached through a directory link`,
};

/**
 * A temp tree, installed as `config.extensionsDir` for the duration of `run`:
 *
 *   <tmp>/extensions/<id>/…   the install folder the guard is asked about
 *   <tmp>/outside/…           outside every folder, readable by this process
 *
 * Entries are keyed `"<id>/<inner path>"` (so `"outside/…"` names the outside
 * tree). A value is either the file's contents or `{ link: "<target>" }`; a link
 * target is stored verbatim, so it is relative to the link's own folder exactly as
 * `ln -s ../../outside/id_ed25519 stolen` would make it.
 */
const withTree = (entries, run) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-symlink-"));
  const extensionsDir = path.join(root, "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.mkdirSync(path.join(root, "outside"), { recursive: true });
  for (const [inner, contents] of Object.entries(entries)) {
    const target = path.join(root, inner);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (contents && typeof contents === "object" && "link" in contents) {
      fs.symlinkSync(String(contents.link), target);
    } else {
      fs.writeFileSync(target, typeof contents === "string" ? contents : JSON.stringify(contents));
    }
  }
  config.extensionsDir = extensionsDir;
  try {
    return run({ root, extensionsDir });
  } finally {
    config.extensionsDir = REAL_EXTENSIONS_DIR;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
};

// ── 1. an escape is refused ──────────────────────────────────────────────────
suite("a link inside an extension folder that points outside is refused", { timeout: 60000 }, () => {
  withTree(
    {
      ...OUTSIDE,
      "extensions/steal/manifest.json": { name: "Steal", version: "1", manifest_version: 3 },
      "extensions/steal/own.js": "export const fine = true;",
      // The F1 reproduction, both shapes of it: a file link and a directory link.
      "extensions/steal/stolen": { link: "../../outside/id_ed25519" },
      "extensions/steal/elsewhere": { link: "../../outside/dir" },
      // An escape the string check could never see: the link itself is contained,
      // and `..` only leaves the folder once the link has already been followed.
      "extensions/steal/wide-open": { link: "../../outside" },
      // One ordinary nested file, so the classic `..` traversal asserted below is
      // checked alongside the new case rather than replacing it.
      "extensions/steal/inner/nested.js": "1;",
    },
    ({ root }) => {
      for (const innerPath of [
        "stolen",
        "./stolen",
        "/stolen",
        "stolen/",
        "elsewhere/inside-dir.txt",
        "wide-open/id_ed25519",
        "wide-open/dir/inside-dir.txt",
        "../../outside/id_ed25519",
        "inner/../../outside/id_ed25519",
      ]) {
        assert.strictEqual(
          resolveInsideExtension("steal", innerPath),
          null,
          `resolveInsideExtension must refuse "${innerPath}"`
        );
        assert.strictEqual(
          resolveExtensionFile("steal", innerPath),
          null,
          `resolveExtensionFile must refuse "${innerPath}"`
        );
      }

      // The refusal is the whole story for this folder: the only names the guard
      // hands out are its real files, and none of them carries the outside secret.
      const own = ["manifest.json", "own.js", "inner/nested.js"].map((innerPath) => {
        const resolved = resolveExtensionFile("steal", innerPath);
        // The guard hands back the REAL path, so the read walks no link component
        // (src/main/extension-server.js). On macOS the temp root is itself behind
        // `/var -> /private/var`, hence `real` rather than the text path.
        assert.strictEqual(resolved, real(path.join(root, `extensions/steal/${innerPath}`)));
        assert.ok(fs.existsSync(resolved));
        return resolved;
      });
      for (const name of own) {
        assert.ok(
          !fs.readFileSync(name, "utf8").includes(SECRET),
          `${name} does not carry the outside file's contents`
        );
      }

      // Every host-side read goes through this guard too, so a linked
      // `manifest.json` — the other way F1 could reach main — leaks nothing: the
      // CSP, the panel page and the options URL all inherit the refusal.
      assert.strictEqual(loadManifest("steal").name, "Steal");
    }
  );
});

// ── 2. a legitimate layout keeps working ─────────────────────────────────────
suite("a link that stays inside the extension folder still resolves", { timeout: 60000 }, () => {
  withTree(
    {
      "extensions/linked/manifest.json": { name: "Linked", version: "1", manifest_version: 3 },
      "extensions/linked/real/own.js": "export const fine = true;",
      "extensions/linked/real/nested/deep.js": "export const deep = true;",
      // A file link, a directory link, and a link to a deeper directory: the
      // layouts a real extension ships (bundled vendor folders, shared assets).
      "extensions/linked/alias.js": { link: "real/own.js" },
      "extensions/linked/shortcut": { link: "real" },
      "extensions/linked/paths": { link: "./real/nested" },
    },
    ({ extensionsDir }) => {
      const read = (innerPath) => {
        const resolved = resolveExtensionFile("linked", innerPath);
        assert.notStrictEqual(resolved, null, `"${innerPath}" must resolve`);
        assert.strictEqual(
          resolved,
          real(path.join(extensionsDir, `linked/${innerPath}`)),
          `"${innerPath}" resolves to its real, contained path`
        );
        // The contract that closes the resolve-then-read window: what the guard hands
        // back is already fully resolved, so the read that follows walks no link.
        assert.strictEqual(resolved, real(resolved), `"${innerPath}" is returned link-free`);
        assert.ok(fs.statSync(resolved).isFile(), `"${innerPath}" must be a readable file`);
        return fs.readFileSync(resolved, "utf8");
      };
      assert.match(read("alias.js"), /fine/);
      assert.match(read("shortcut/own.js"), /fine/);
      assert.match(read("shortcut/nested/deep.js"), /deep/);
      assert.match(read("paths/deep.js"), /deep/);
      assert.match(read("real/own.js"), /fine/, "and the plain path each one aliases");
      // Which is what the guard's answer for a link now is: the file it really is.
      assert.strictEqual(
        resolveExtensionFile("linked", "alias.js"),
        path.join(real(path.join(extensionsDir, "linked")), "real/own.js")
      );

      // The folder itself is not under suspicion: only paths are.
      assert.ok(extensionFolders().includes("linked"), "the folder is still discovered");
      assert.strictEqual(resolveInsideExtension("linked", ""), real(path.join(extensionsDir, "linked")));
    }
  );
});

// ── 3. the two layers agree about extension roots ────────────────────────────
suite("a symlinked extension root is refused by the server and skipped by the scan", { timeout: 60000 }, () => {
  // Decided policy (issue #21): A SYMLINKED FOLDER IS NEVER AN EXTENSION ROOT.
  // Discovery reaches folders through `readdir({ withFileTypes: true })` +
  // `isDirectory()`, which never reports a link (src/main/extensions.js); the server
  // refuses a linked root for the same reason, so the layers cannot disagree about
  // what an extension is — and the disagreement could never be the permissive one.
  withTree(
    {
      "extensions/real.ext/manifest.json": {
        name: "__MSG_extName__",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
        devtools_page: "devtools.html",
        background: { service_worker: "bg.js" },
      },
      // A catalog the target really has: without it, "a linked root serves nothing"
      // would pass even with the refusal removed (an extension with no `_locales`
      // serves nothing either), which is exactly the vacuity this round exists to
      // catch. With it, a host that trusts a linked root produces a bundle with
      // messages in it, and the assertion below can see the difference.
      "extensions/real.ext/_locales/en/messages.json": {
        extName: { message: "Real EN" },
      },
      "extensions/real.ext/devtools.html": "<html></html>",
      "extensions/real.ext/bg.js": "console.log('bg');",
      // A link sitting IN the extensions dir, i.e. a folder the developer could
      // create by name alone. Its content is a real, valid extension.
      "extensions/linked.ext": { link: "real.ext" },
    },
    () => {
      for (const innerPath of ["", "manifest.json", "bg.js", "devtools.html"]) {
        const label = innerPath || "<root>";
        assert.strictEqual(
          resolveInsideExtension("linked.ext", innerPath),
          null,
          `the server must refuse ${label} under a linked id`
        );
        assert.strictEqual(
          resolveExtensionFile("linked.ext", innerPath),
          null,
          `resolveExtensionFile must refuse ${label} under a linked id`
        );
      }
      // The root check is also what `ipc.js:350` / `:803` gate on, and what
      // `loadManifest` reads through: a linked id gets no manifest, so no CSP, no
      // panel page, no options URL, no registration.
      assert.deepStrictEqual(loadManifest("linked.ext"), {});

      // And the same refusal applies to i18n-host HANDED the linked path directly —
      // doctrine in the module, not only in its callers (src/main/i18n-host.js's
      // `containmentFor` lstats the root it receives). A future caller that forgot to
      // check would otherwise get a full bundle out of a folder the scanner refuses to
      // even list, and the two layers' disagreement would be the permissive one.
      const linkedRoot = path.join(config.extensionsDir, "linked.ext");
      const { log, warnings } = quiet();
      const bundle = i18nHost.loadBundle({
        root: linkedRoot,
        extensionId: "linked.ext",
        uiLocaleOverride: "en",
        log,
      });
      assert.deepStrictEqual(bundle.messages, {}, "a linked root serves no messages to i18n-host alone");
      assert.ok(
        warnings.some((w) => /refused|cannot be resolved/.test(w)),
        `and the refusal is reported, not silent: ${JSON.stringify(warnings)}`
      );
      assert.deepStrictEqual(
        i18nHost.localizeManifest({
          manifest: { name: "__MSG_extName__" },
          rawText: '{"name":"__MSG_extName__"}',
          root: linkedRoot,
          extensionId: "linked.ext",
          uiLocaleOverride: "en",
          log,
        }).name,
        "__MSG_extName__",
        "the marker stays unresolved under a linked root too"
      );

      assert.ok(extensionFolders().includes("real.ext"), "the real folder is discovered");
      assert.ok(!extensionFolders().includes("linked.ext"), "the linked folder is not");
      assert.deepStrictEqual(
        scanExtensions().map((entry) => entry.extensionId),
        ["real.ext"],
        "the panel scan skips it too"
      );
      assert.deepStrictEqual(
        scanBackgroundExtensions().map((entry) => entry.extensionId),
        ["real.ext"],
        "and so does the background scan"
      );
    }
  );
});

// ── 4. reserved paths and the main-side reads they exist for ─────────────────
suite("the reserved inner paths keep their rules, and main-side reads still resolve", { timeout: 60000 }, () => {
  withTree(
    {
      ...OUTSIDE,
      "extensions/reserved/manifest.json": {
        name: "__MSG_extName__",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
        background: { service_worker: "bg.js", type: "module" },
      },
      "extensions/reserved/bg.js": "import { tag } from './log.js';\n",
      "extensions/reserved/log.js": "export const tag = () => 'ok';\n",
      // `_locales` reached through a link that stays inside the folder. The i18n
      // bundle is read by MAIN from the root (`serveI18nBundle` ->
      // `resolveInsideExtension(id, "")` -> src/main/i18n-host.js), so the realpath
      // change could have broken localization without breaking one page-served file.
      "extensions/reserved/locales-real/en/messages.json": {
        hello: { message: "Hello" },
        extName: { message: "Reserved EN" },
      },
      "extensions/reserved/_locales": { link: "locales-real" },
      // A link planted AT each reserved name. The reservation must win over the
      // containment rules too — those paths stay unreachable from disk in BOTH
      // directions (docs/features/BACKGROUND-WORKER.md).
      "extensions/reserved/__rozenite_background__": { link: "../../outside/id_ed25519" },
      "extensions/reserved/__rozenite_i18n__": { link: "../../outside/id_ed25519" },
      // And a plain, CONTAINED real file at each reserved name. This folder exists so
      // the assertion below can only be satisfied by the reservation itself: the same
      // names resolve through `resolveInsideExtension`, which does not know about the
      // reservation. Proving the refusal is the reservation and not a containment
      // accident is the whole point — that is what keeps the host's generated
      // bootstrap document and i18n bundle from being pre-empted by a file.
      "extensions/plain-reserved/manifest.json": { name: "Plain", version: "1", manifest_version: 3 },
      "extensions/plain-reserved/__rozenite_background__": "<html><body>SHADOWED</body></html>",
      "extensions/plain-reserved/__rozenite_i18n__": "{}",
      // The bootstrap document's `?script=` may name an in-folder link, and a plain
      // escaping link must still be refused.
      "extensions/reserved/alias-bg.js": { link: "bg.js" },
      "extensions/reserved/stolen.js": { link: "../../outside/id_ed25519" },
      // A stylesheet the CSS-localisation path will read through an in-folder link.
      "extensions/reserved/styles/panel.css": "a{content:'__MSG_hello__'}\n",
      "extensions/reserved/styles-link": { link: "styles" },
      // A manifest that is ITSELF a link staying inside the folder (a real build
      // layout: ship the real file under `dist/`, link it at the top): the root both
      // manifest-localization and the served bundle anchor on must survive it.
      "extensions/linked-manifest/dist/manifest.json": {
        name: "__MSG_extName__",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
      },
      "extensions/linked-manifest/manifest.json": { link: "dist/manifest.json" },
      "extensions/linked-manifest/_locales/en/messages.json": {
        extName: { message: "Linked Manifest EN" },
      },
    },
    ({ extensionsDir }) => {
      for (const reserved of [BACKGROUND_BOOTSTRAP_PATH, I18N_BUNDLE_PATH]) {
        // A plain folder, contained REAL files at the reserved names, no links
        // involved: a refusal here can only come from the reservation itself — the
        // guard beneath it resolves the same path, which is what makes the refusal
        // the reservation and not a containment accident. That distinction is the
        // host's own: the bootstrap document and the i18n bundle must not be
        // pre-empted by a file the extension shipped under those names.
        assert.notStrictEqual(
          resolveInsideExtension("plain-reserved", reserved),
          null,
          `${reserved} is a contained file; only the reservation can refuse it`
        );
        for (const innerPath of [reserved, `/${reserved}`]) {
          assert.strictEqual(
            resolveExtensionFile("reserved", innerPath),
            null,
            `"${innerPath}" is reserved and must never resolve from disk`
          );
          assert.strictEqual(
            resolveExtensionFile("plain-reserved", innerPath),
            null,
            `"${innerPath}" is refused for a plain folder too, i.e. by the reservation`
          );
        }
      }

      // 4a. The bootstrap script: containment, not reservation — so a linked script
      //     is served and an escaping one is refused, exactly like any other file.
      assert.strictEqual(
        resolveExtensionFile("reserved", "bg.js"),
        real(path.join(extensionsDir, "reserved/bg.js"))
      );
      // A linked script resolves to the file it really is, and that is the answer the
      // server reads — the resolve-then-read window is why it is the real path.
      const linkedScript = resolveExtensionFile("reserved", "alias-bg.js");
      assert.strictEqual(linkedScript, real(path.join(extensionsDir, "reserved/bg.js")));
      assert.match(fs.readFileSync(linkedScript, "utf8"), /log\.js/, "and it is readable");
      assert.strictEqual(resolveExtensionFile("reserved", "stolen.js"), null);
      assert.strictEqual(resolveExtensionFile("reserved", "../real.ext/bg.js"), null);

      // 4b. The i18n bundle: the root resolves, and the messages behind the in-folder
      //     link reach main exactly as before.
      const root = resolveInsideExtension("reserved", "");
      assert.strictEqual(root, real(path.join(extensionsDir, "reserved")));
      const warnings = [];
      const log = { warn: (message) => warnings.push(message), log() {}, error() {} };
      const bundle = i18nHost.loadBundle({
        root,
        extensionId: "reserved",
        uiLocaleOverride: "en",
        log,
      });
      assert.strictEqual(bundle.defaultLocale, "en", "the linked _locales was read");
      assert.strictEqual(
        i18nHost.localizeManifest({
          manifest: { name: "__MSG_extName__" },
          rawText: '{"name":"__MSG_extName__"}',
          root,
          extensionId: "reserved",
          uiLocaleOverride: "en",
          log,
        }).name,
        "Reserved EN"
      );
      assert.deepStrictEqual(warnings, [], "no localization step silently failed");

      // 4c. The third main-side read through these paths: the CSS localisation the
      //     protocol handler does (`serveLocalizedCss` passes
      //     `resolveInsideExtension(id, "")` as its root and the CONTAINED path as the
      //     file), so a stylesheet reached through an in-folder link still gets its
      //     markers substituted and still gets them from the linked `_locales`.
      const cssPath = resolveExtensionFile("reserved", "styles-link/panel.css");
      assert.strictEqual(
        cssPath,
        real(path.join(extensionsDir, "reserved/styles/panel.css")),
        "a stylesheet behind an in-folder link resolves to the real file"
      );
      assert.strictEqual(i18nHost.cssUsesMessages(cssPath), true, "the marker is seen");
      assert.strictEqual(
        i18nHost.localizeCssFile({
          text: fs.readFileSync(cssPath, "utf8"),
          root,
          extensionId: "reserved",
          uiLocaleOverride: "en",
          log,
        }),
        "a{content:'Hello'}\n",
        "and it is localized from the linked bundle"
      );

      // 4d. The root the manifest-localization anchors on must be the EXTENSION
      //     folder, not `path.dirname` of the manifest's realpath: for a manifest
      //     that is itself a contained link (`manifest.json -> dist/manifest.json`)
      //     the dirname is `…/dist`, where there is no `_locales`. That split the
      //     two readers of one extension's messages — `getManifest().name` kept the
      //     literal `__MSG_extName__` (no default_locale seen under `dist/`) while
      //     the `__rozenite_i18n__` bundle the frame loaded DID resolve it, and the
      //     bundle cache held two entries for one folder. The pin: what the host
      //     reports and what the frame is served must be the same string.
      const linkedManifest = loadManifest("linked-manifest");
      const linkedBundle = i18nHost.loadBundle({
        root: resolveInsideExtension("linked-manifest", ""),
        extensionId: "linked-manifest",
        uiLocaleOverride: "en",
        log,
      });
      assert.strictEqual(linkedManifest.name, "Linked Manifest EN");
      assert.strictEqual(
        i18n.getMessage(linkedBundle, ["extName"]),
        linkedManifest.name,
        "chrome.runtime.getManifest().name and the served bundle agree"
      );
    }
  );
});

// ── 5. missing stays distinguishable from refused ────────────────────────────
suite("a path that does not exist is missing, not refused", { timeout: 60000 }, () => {
  withTree(
    {
      ...OUTSIDE,
      "extensions/plain/manifest.json": { name: "Plain", version: "1", manifest_version: 3 },
      "extensions/plain/here.js": "1;",
      // A dangling link, and a link to a real outside folder whose final segment does
      // not exist there: in both cases realpath has nothing to compare, and the
      // honest answer is "there is no file here", not "this path is refused".
      "extensions/plain/dangling": { link: "nope/nothing-here" },
      "extensions/plain/out-link": { link: "../../outside" },
    },
    ({ extensionsDir }) => {
      // src/main/content-scripts.js reports a manifest path that names no file as
      // MISSING and a path that escapes as REFUSED. A realpath guard that answered
      // null for every unresolvable path would turn the first, honest message into
      // the second, alarming one.
      for (const innerPath of [
        "nope.js",
        "dangling",
        "out-link/not-here-either",
        // Through a plain FILE component: ENOTDIR. There is nothing that could exist
        // beyond it, which is a missing file — the same answer the guard gave before
        // the realpath rule existed, and the honest one for a developer whose
        // manifest names `here.js/gone.js`.
        "here.js/gone.js",
      ]) {
        const resolved = resolveExtensionFile("plain", innerPath);
        assert.strictEqual(
          resolved,
          path.join(extensionsDir, `plain/${innerPath}`),
          `"${innerPath}" reports the contained name`
        );
        // Nothing is readable through the name either way, which is why returning it
        // is safe: existence is the caller's question to ask.
        assert.strictEqual(fs.existsSync(resolved), false, `"${innerPath}" has no file behind it`);
        assert.throws(() => fs.statSync(resolved));
      }
      // A path that DOES exist outside, by contrast, is a hard refusal (suite 1) —
      // "missing" is reserved for paths with nothing behind them at all.
      assert.strictEqual(resolveExtensionFile("plain", "out-link/id_ed25519"), null);
    }
  );
});

// ── 6. the reads that build their OWN paths under the root ───────────────────
suite("the i18n and CSS-localisation reads are contained too: an escaping _locales is not read", { timeout: 60000 }, () => {
  // The page-facing guard sees only the URL's inner path, so it refused
  // `_locales/en/messages.json` while the message bundle the HOST builds was
  // assembled from `path.join(root, "_locales", dir, "messages.json")` — a path that
  // never passed a guard. One link, `victim/_locales -> outside`, therefore served the
  // outside JSON to `rozenite://victim/__rozenite_i18n__` (the reviewer's repro),
  // through the route `serveI18nBundle`/`serveLocalizedCss` -> i18n-host. So the
  // realpath rule lives INSIDE src/main/i18n-host.js, on every path it derives.
  // The assertion is "the outside bytes never reach the bundle", not "404": a bundle
  // with no catalog is a legitimate answer (an extension with no `_locales` gets one),
  // and it is what `serveI18nBundle` returns here too.
  const OUTSIDE_BUNDLE = {
    "outside/locales/en/messages.json": {
      extName: { message: "OUTSIDE-BUNDLE-SECRET" },
      hello: { message: "OUTSIDE-HELLO-SECRET" },
    },
    // Reached only if a derived path is trusted without containment: the catalog the
    // manifest's `default_locale` selects, behind a link at the locale directory.
    "outside/by-locale/en/messages.json": {
      extName: { message: "OUTSIDE-LOCALE-DIR-SECRET" },
    },
  };

  // 6a. `_locales` itself is the link.
  withTree(
    {
      ...OUTSIDE_BUNDLE,
      "extensions/victim/manifest.json": {
        name: "__MSG_extName__",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
      },
      "extensions/victim/_locales": { link: "../../outside/locales" },
      "extensions/victim/styles/panel.css": "a{content:'__MSG_hello__'}\n",
    },
    ({ extensionsDir }) => {
      // The page-facing verdict was already correct — which is exactly why this route
      // looked closed. It has to stay correct.
      assert.strictEqual(resolveExtensionFile("victim", "_locales/en/messages.json"), null);
      assert.strictEqual(resolveExtensionFile("victim", "_locales"), null);

      const root = resolveInsideExtension("victim", "");
      const { log, warnings } = quiet();
      const bundle = i18nHost.loadBundle({
        root,
        extensionId: "victim",
        uiLocaleOverride: "en",
        log,
      });
      const rendered = JSON.stringify(bundle);
      assert.ok(!/OUTSIDE-BUNDLE-SECRET/.test(rendered), "the outside catalog never enters the bundle");
      assert.ok(!/OUTSIDE-HELLO-SECRET/.test(rendered), "and neither does any message from it");
      assert.deepStrictEqual(bundle.messages, {}, "no message is served that this folder does not have");
      assert.strictEqual(
        i18nHost.localizeManifest({
          manifest: { name: "__MSG_extName__" },
          rawText: '{"name":"__MSG_extName__"}',
          root,
          extensionId: "victim",
          uiLocaleOverride: "en",
          log,
        }).name,
        "__MSG_extName__",
        "so the marker stays unresolved instead of resolving to an outside file"
      );
      const css = i18nHost.localizeCssFile({
        text: fs.readFileSync(resolveExtensionFile("victim", "styles/panel.css"), "utf8"),
        root,
        extensionId: "victim",
        uiLocaleOverride: "en",
        log,
      });
      assert.strictEqual(css, "a{content:'__MSG_hello__'}\n", "and the CSS gets no outside substitution");
      assert.ok(
        warnings.some((w) => /_locales/.test(w)),
        `the refused read is reported, not silent: ${JSON.stringify(warnings)}`
      );
    }
  );

  // 6b. The link is deeper: a real `_locales/en/` whose `messages.json` is a link.
  // (A LINKED locale directory is not a vector at all — `readdir({ withFileTypes:
  // true })` + `isDirectory()` never reports a link — which is why this is the shape
  // that matters, and why the per-entry check exists to keep it that way.)
  withTree(
    {
      ...OUTSIDE_BUNDLE,
      "extensions/by-locale/manifest.json": {
        name: "__MSG_extName__",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
      },
      // Four levels up: the link lives in `_locales/en/`, so `en` -> `_locales` ->
      // `by-locale` -> `extensions` -> the temp root.
      "extensions/by-locale/_locales/en/messages.json": { link: "../../../../outside/by-locale/en/messages.json" },
      // A real, contained catalog next to it, so the answer cannot be "this folder has
      // no catalogs at all": containment must refuse the link and keep the real one.
      "extensions/by-locale/_locales/pt/messages.json": { hello: { message: "Olá" } },
    },
    () => {
      assert.strictEqual(resolveExtensionFile("by-locale", "_locales/en/messages.json"), null);
      const root = resolveInsideExtension("by-locale", "");
      const { log, warnings } = quiet();
      const bundle = i18nHost.loadBundle({
        root,
        extensionId: "by-locale",
        uiLocaleOverride: "pt",
        log,
      });
      assert.ok(
        !/OUTSIDE-LOCALE-DIR-SECRET/.test(JSON.stringify(bundle)),
        "the escaping messages.json is not read"
      );
      assert.strictEqual(i18n.getMessage(bundle, ["hello"]), "Olá", "the contained catalog still is");
      assert.ok(
        warnings.some((w) => /_locales\/en\/messages\.json unreadable/.test(w)),
        `and the refused read is reported: ${JSON.stringify(warnings)}`
      );
    }
  );

  // 6c. The manifest read, which is the same derive-your-own-path pattern one level up.
  withTree(
    {
      ...OUTSIDE_BUNDLE,
      "outside/manifest-link/manifest.json": { default_locale: "en", name: "OUTSIDE-MANIFEST-SECRET" },
      "extensions/fake-manifest/manifest.json": { link: "../../../outside/manifest-link/manifest.json" },
      "extensions/fake-manifest/_locales/pt/messages.json": { hello: { message: "Olá" } },
    },
    () => {
      // `default_locale` must not be readable from outside the folder, even through the
      // name every caller starts from.
      const { log, warnings } = quiet();
      const bundle = i18nHost.loadBundle({
        root: resolveInsideExtension("fake-manifest", ""),
        extensionId: "fake-manifest",
        uiLocaleOverride: "pt",
        log,
      });
      assert.strictEqual(bundle.defaultLocale, "", "no default locale is taken from outside the folder");
      assert.ok(!/OUTSIDE-MANIFEST-SECRET/.test(JSON.stringify(bundle)));
      assert.ok(
        warnings.some((w) => /manifest\.json/.test(w)),
        `a manifest the host may not read is reported, not treated as absent: ${JSON.stringify(warnings)}`
      );
      assert.strictEqual(i18n.getMessage(bundle, ["hello"]), "Olá", "the contained catalog still is");
    }
  );

  // 6d. The linked directory that stays INSIDE. `Dirent.isDirectory()` reads the
  // directory ENTRY, so it is false for every symlink: under an entry-type rule alone
  // a contained `_locales/en -> vendor/en` is silently skipped — no catalog, no
  // warning — and the per-entry `contain()` in `localeDirectories` has no reachable
  // input (a real directory and a link cannot share one name), which is why removing
  // that check survived all 638 tests. This fixture kills both mutants: with the
  // entry-type rule alone, the contained `en` vanishes and `hello` goes unanswered;
  // with the check removed, the escaped `_locales/de` drops out of the listing UNSAID
  // (its bytes would still be refused later by the read's own check — what the
  // per-entry check owns is the REPORT). Same doctrine as suite 2: containment, not
  // "no symlinks".
  withTree(
    {
      ...OUTSIDE_BUNDLE,
      "extensions/linked-locale/manifest.json": {
        name: "Linked Locale",
        version: "1",
        manifest_version: 3,
        default_locale: "en",
      },
      "extensions/linked-locale/vendor/en/messages.json": { hello: { message: "Hello" } },
      "extensions/linked-locale/_locales/en": { link: "../vendor/en" },
      // An escaped locale directory: readdir sees the LINK, so the only line between
      // this name and the outside catalog's KEY NAMES is the per-entry check, which
      // warns — the escape must arrive reported, never served.
      "extensions/linked-locale/_locales/de": { link: "../../../outside/locales" },
    },
    () => {
      const { log, warnings } = quiet();
      const bundle = i18nHost.loadBundle({
        root: resolveInsideExtension("linked-locale", ""),
        extensionId: "linked-locale",
        uiLocaleOverride: "en",
        log,
      });
      assert.strictEqual(
        i18n.getMessage(bundle, ["hello"]),
        "Hello",
        "a contained linked locale directory is read like any other"
      );
      assert.ok(
        warnings.some((w) => /_locales\/de is refused/.test(w)),
        `the escaped linked locale directory is refused AND reported: ${JSON.stringify(warnings)}`
      );
      assert.ok(!/OUTSIDE-/.test(JSON.stringify(bundle)), "and its catalog never enters the bundle");
    }
  );
});

if (!symlinksAvailable) {
  test("symlink containment could not be exercised on this platform", () => {
    // Keeps the skip visible: the rule above is untested when unprivileged symlink
    // creation is unavailable (Windows without developer mode), and a silent
    // zero-test file would read as a pass.
    assert.ok(true, "symlink creation refused this process — the suites above are skipped");
  });
}
