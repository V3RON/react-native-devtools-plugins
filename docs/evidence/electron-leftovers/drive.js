// Evidence driver for docs/evidence/electron-leftovers (see README.md there).
//
//   node docs/evidence/electron-leftovers/drive.js <wrapDir> <outDir>
//
// Needs the stack from README.md already running (Metro on 8081, the inspected Chromium
// on 9292, fake-cdp on 9293, the target page on 9295). It launches the shell three times
// (ports 9294) and drives the REAL frontend UI over CDP:
//
//   A. default config + auto-answering save dialog: console "Save as..." (right-click a
//      message, pick the menu item), Network "Save all as HAR", openInNewTab.
//   B. dialog auto-answers "cancelled": the same console save raises canceledSaveURL.
//   C. DEVTOOLS_HOST_CONFIG enables the AI features the default config switches off.
//
// Menus are real clicks: the hosted frontend draws its own soft context menu in the DOM,
// so the driver right-clicks and clicks the entry with Input.dispatchMouseEvent.
const fs = require("node:fs");
const path = require("node:path");
const L = require("./lib");

const [wrapDir, outDir] = process.argv.slice(2);
const evidence = __dirname;
const saved = path.join(outDir, "saved");
const openLog = path.join(outDir, "open.log");
fs.rmSync(saved, { recursive: true, force: true });
fs.mkdirSync(saved, { recursive: true });
fs.rmSync(openLog, { force: true });
const results = {};

/** Reload the inspected page with the frontend's own action (Page.reload on its session). */
const reloadViaFrontend = (c) =>
  c.evaluate(`import('./ui/legacy/legacy.js').then(m => m.ActionRegistry.ActionRegistry.instance().getAction('inspector-main.reload').execute())`);

/** Every [role=tab] label in the document, shadow roots included. */
const TABS = `(() => { const out = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.getAttribute && el.getAttribute('role') === 'tab') out.push(el.textContent.trim()); } }; walk(document); return out; })()`;

const waitFor = async (predicate, ms = 15000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = await predicate();
    if (value) return value;
    await L.sleep(250);
  }
  return null;
};

/** Install the recorders every scenario uses. */
const instrument = (c) =>
  c.evaluate(`(() => {
    window.__events = [];
    for (const name of ["savedURL", "canceledSaveURL", "appendedToURL"]) {
      const original = InspectorFrontendAPI[name];
      InspectorFrontendAPI[name] = function (...args) {
        window.__events.push([name, ...args]);
        return original.apply(this, args);
      };
    }
    const host = window.InspectorFrontendHost;
    window.__calls = [];
    for (const name of ["save", "append", "close"]) {
      const original = host[name];
      host[name] = (...args) => { window.__calls.push([name, String(args[0]), String(args[1] ?? '').length]); return original(...args); };
    }
    return true;
  })()`);

/** Click the visible soft-menu entry whose text matches (the frontend draws its own menu). */
const clickMenuEntry = async (c, pattern) => {
  const box = await waitFor(
    () =>
      c.evaluate(`(() => {
        const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
        const hits = [];
        const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.getAttribute && el.getAttribute('role') === 'menuitem' && re.test(el.textContent.trim())) hits.push(el); } };
        walk(document);
        const el = hits[0]; if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: el.textContent.trim() };
      })()`),
    5000
  );
  if (!box) {
    const seen = await c.evaluate(`(() => { const o = []; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.getAttribute && el.getAttribute('role') === 'menuitem') o.push(el.textContent.trim()); } }; walk(document); return o; })()`);
    throw new Error(`no menu entry matching ${pattern}; menu has: ${JSON.stringify(seen)}`);
  }
  await c.click(box.x, box.y);
  return box.text;
};

/** Right-click a console message, then choose the soft-menu entry matching `pattern`. */
const chooseFromConsoleMenu = async (c, pattern) => {
  const box = await c.evaluate(`(() => {
    const out = [];
    const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); if (el.classList && el.classList.contains('console-message-wrapper')) out.push(el); } };
    walk(document);
    const el = out[out.length - 1]; if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + 60, y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error("no console message to right-click");
  await c.click(box.x, box.y, "right");
  return clickMenuEntry(c, pattern);
};

const withShell = async (name, env, body) => {
  const shell = L.launchShell({ wrapDir, userData: path.join(outDir, `ud-${name}`), env });
  try {
    const target = await L.frontendTarget();
    const c = await L.connect(target);
    await L.sleep(7000);
    await instrument(c);
    await body(c, shell);
    c.close();
  } finally {
    await shell.stop();
  }
};

const showFile = async (file, shot) => {
  // A throwaway tab of the inspected Chromium, so the inspected page itself stays put.
  const tab = await (
    await fetch(`http://127.0.0.1:9292/json/new?file://${file}`, { method: "PUT" })
  ).json();
  const c = await L.connect(tab);
  await L.sleep(1200);
  await c.screenshot(shot);
  c.close();
  await fetch(`http://127.0.0.1:9292/json/close/${tab.id}`);
};

(async () => {
  // ── A ─────────────────────────────────────────────────────────────────────
  await withShell(
    "A",
    { DEVTOOLS_TEST_SAVE_DIALOG: saved, DEVTOOLS_TEST_OPEN_LOG: openLog },
    async (c) => {
      results.hostConfig = JSON.parse(
        await c.evaluate(`new Promise((r) => InspectorFrontendHost.getHostConfig(r)).then(JSON.stringify)`)
      );
      results.drawerTabsDefault = await c.evaluate(TABS);
      await c.screenshot(path.join(evidence, "01-default-host-config.png"));

      // Console "Save as..." — save, then appended chunks, then close.
      const picked = await chooseFromConsoleMenu(c, /^Save as\.\.\.$/);
      const file = await waitFor(() => fs.readdirSync(saved).find((f) => f.endsWith(".log")) || null);
      await L.sleep(1500);
      results.consoleMenuEntry = picked;
      results.consoleSaveFile = file;
      results.consoleSaveContent = file ? fs.readFileSync(path.join(saved, file), "utf8") : null;
      results.consoleEvents = JSON.parse(await c.evaluate("JSON.stringify(window.__events)"));
      results.consoleCalls = JSON.parse(await c.evaluate("JSON.stringify(window.__calls)"));
      if (file) {
        fs.copyFileSync(path.join(saved, file), path.join(evidence, "console-save-as.log"));
        await showFile(path.join(evidence, "console-save-as.log"), path.join(evidence, "03-saved-console-log.png"));
      }

      // Network "Save all as HAR": the frontend's FileManager.save with forceSaveAs.
      await c.evaluate(`import('./ui/legacy/legacy.js').then(m => m.InspectorView.InspectorView.instance().showPanel('network'))`);
      await L.sleep(2500);
      await reloadViaFrontend(c);
      await L.sleep(4000);
      await c.screenshot(path.join(evidence, "02-network-panel.png"));
      const harBox = await c.evaluate(`(() => {
        const walk = (root, out) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot, out); if (el.tagName === 'TR' && el.classList.contains('data-grid-data-grid-node')) out.push(el); } return out; };
        const rows = walk(document, []).filter(r => r.getBoundingClientRect().height > 0);
        if (!rows.length) return null;
        const r = rows[0].getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2, n: rows.length };
      })()`);
      results.networkRows = harBox && harBox.n;
      if (harBox) {
        // A request row's own menu: "Open in new tab" is the frontend's real route to
        // InspectorFrontendHost.openInNewTab.
        results.rowMenuEntry = await chooseFromNetworkMenu(c, harBox, /^Open in new tab$/);
        await L.sleep(800);
        results.openLogAfterRowMenu = fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8").trim().split("\n") : [];
        await c.evaluate("window.__events.length = 0");
        // The toolbar's "Export HAR (sanitized)..." button: exportAll() opens a FileOutputStream
        // (save), writes the HAR (append chunks) and closes it.
        const button = await c.evaluate(`(() => { let hit = null; const walk = (root) => { for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); const t = el.getAttribute && el.getAttribute('title'); if (!hit && el.tagName === 'BUTTON' && /Export HAR \\(sanitized\\)/.test(t || '')) { const r = el.getBoundingClientRect(); if (r.width) hit = { x: r.x + r.width / 2, y: r.y + r.height / 2, t }; } } }; walk(document); return hit; })()`);
        if (!button) throw new Error("no Export HAR button");
        await c.click(button.x, button.y);
        const har = button.t;
        results.harMenuEntry = har;
        const harFile = await waitFor(() => fs.readdirSync(saved).find((f) => f.endsWith(".har")) || null);
        results.harFile = harFile;
        if (harFile) {
          // The file is created by save and filled by append: wait for a complete document.
          const parsed = await waitFor(() => {
            try {
              return JSON.parse(fs.readFileSync(path.join(saved, harFile), "utf8"));
            } catch {
              return null;
            }
          });
          results.harEntries = parsed.log.entries.map((e) => `${e.request.method} ${e.request.url}`);
          fs.copyFileSync(path.join(saved, harFile), path.join(evidence, "network-save-as.har"));
        }
        results.harEvents = JSON.parse(await c.evaluate("JSON.stringify(window.__events)"));
      }

      // openInNewTab: the frontend's own helper, then direct calls with bad schemes.
      c.consoleLines.length = 0;
      await c.evaluate(`import('./ui/legacy/legacy.js').then(m => m.UIUtils.openInNewTab('https://reactnative.dev/docs/debugging'))`);
      for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "smb://host/share", "ms-msdt:/id", "not a url"]) {
        await c.evaluate(`InspectorFrontendHost.openInNewTab(${JSON.stringify(bad)})`);
      }
      await c.evaluate(`InspectorFrontendHost.openInNewTab('http://localhost:8081/rozenite/')`);
      await L.sleep(1000);
      results.openLog = fs.existsSync(openLog) ? fs.readFileSync(openLog, "utf8").trim().split("\n") : [];
      results.openRefusals = c.consoleLines.filter((l) => /openInNewTab/.test(l));
    }
  );

  // ── B ─────────────────────────────────────────────────────────────────────
  fs.readdirSync(saved).forEach((f) => fs.rmSync(path.join(saved, f)));
  await withShell("B", { DEVTOOLS_TEST_SAVE_DIALOG: "cancel" }, async (c) => {
    await chooseFromConsoleMenu(c, /^Save as\.\.\.$/);
    await L.sleep(3000);
    results.cancelEvents = JSON.parse(await c.evaluate("JSON.stringify(window.__events)"));
    results.cancelCalls = JSON.parse(await c.evaluate("JSON.stringify(window.__calls)"));
    results.cancelFilesWritten = fs.readdirSync(saved);
  });

  // ── C ─────────────────────────────────────────────────────────────────────
  await withShell(
    "C",
    {
      DEVTOOLS_HOST_CONFIG: JSON.stringify({
        aidaAvailability: { enabled: true },
        devToolsConsoleInsights: { enabled: true },
        devToolsFreestyler: { enabled: true },
      }),
    },
    async (c) => {
      results.overrideAida = JSON.parse(
        await c.evaluate(`new Promise((r) => InspectorFrontendHost.getHostConfig(r)).then(x => JSON.stringify(x.aidaAvailability))`)
      );
      results.drawerTabsOverride = await c.evaluate(TABS);
      await c.screenshot(path.join(evidence, "04-ai-config-override.png"));
    }
  );

  fs.writeFileSync(path.join(evidence, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
})().catch((error) => {
  console.error(error);
  fs.writeFileSync(path.join(evidence, "results.partial.json"), JSON.stringify(results, null, 2) + "\n");
  process.exit(1);
});

async function chooseFromNetworkMenu(c, box, pattern) {
  await c.click(box.x, box.y, "right");
  return clickMenuEntry(c, pattern);
}
