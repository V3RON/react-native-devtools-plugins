// Evidence driver: drives the REAL shell (Electron, remote debugging on --electron-port)
// hosting the real DevTools frontend, with the two demo extensions in ./fixtures.
//
//   node drive.js --electron-port 9284 --out <dir>
//
// Steps (each screenshot proves a distinct state):
//   01 panel A, nothing written yet
//   02 panel A writes storage.session -> the background worker and the devtools page of
//      the SAME extension report hearing onChanged; the panel's own listener fired too
//   03 options page of A (a separate window) opened, then written to again from the panel:
//      the options page read the earlier value and heard the new change
//   04 panel of extension B: its session storage is EMPTY and it heard none of A's changes
//   05 panel B writes the same key; only B's contexts report it
//   06 panel A reloaded (tab switch recreates it): reads the value from the host's store
//   07 options page of A after one more write: heard A's changes only, never B's
const fs = require("fs");
const path = require("path");
const { getJson, connect, evaluate } = require("./cdp");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("electron-port", 9284));
const OUT = path.resolve(arg("out", "."));
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = `http://127.0.0.1:${PORT}`;

const failures = [];
const expect = (condition, message) => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${message}`);
  if (!condition) failures.push(message);
};

const shot = async (client, name) => {
  const { data } = await client.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
  console.log(`saved ${name}`);
};

const targetWith = async (predicate, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await getJson(`${base}/json`)).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error("target not found");
    await sleep(250);
  }
};

const clickTab = async (frontend, tabId) => {
  const rect = await evaluate(
    frontend,
    `(() => {
      const find = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.id === ${JSON.stringify(tabId)}) return el;
          if (el.shadowRoot) { const hit = find(el.shadowRoot); if (hit) return hit; }
        }
      };
      const r = find(document).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`
  );
  for (const type of ["mousePressed", "mouseReleased"]) {
    await frontend.send("Input.dispatchMouseEvent", { type, x: rect.x, y: rect.y, button: "left", clickCount: 1 });
  }
  await sleep(800);
};

const text = (client, id) => evaluate(client, `document.getElementById(${JSON.stringify(id)}).textContent`);

(async () => {
  const frontendTarget = await targetWith((t) => t.type === "page" && t.url.includes("rn_fusebox"));
  const frontend = await connect(frontendTarget.webSocketDebuggerUrl);
  await frontend.send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 800, deviceScaleFactor: 1, mobile: false });
  await sleep(800);

  const panelOf = async (ext) => {
    const target = await targetWith((t) => t.url === `rozenite://${ext}/panel.html`);
    return connect(target.webSocketDebuggerUrl);
  };

  // ── 01 ────────────────────────────────────────────────────────────────────
  await clickTab(frontend, "tab-ext.storage-demo-a.panel.html");
  const a = await panelOf("storage-demo-a");
  await sleep(500);
  await shot(frontend, "01-panel-a-initial.png");
  expect((await text(a, "snapshot")).trim() === "{}", "A: session storage starts empty");

  // ── 02 ────────────────────────────────────────────────────────────────────
  await evaluate(a, `document.getElementById("write").click()`);
  await sleep(1200);
  const wroteA = await text(a, "wrote");
  const heardA = await text(a, "heard");
  console.log(`A heard:\n${heardA}`);
  expect(/session\.set\(\{"counter":1/.test(wroteA), "A: the panel wrote session.counter = 1");
  expect(/\[background worker\] session\.counter: \(absent\) -> \{?.*"counter":1|\[background worker\] session\.counter: \(absent\) -> 1/.test(heardA), "A: the BACKGROUND WORKER's own onChanged fired for a write made in the panel");
  expect(/\[devtools page\] session\.counter/.test(heardA), "A: the DEVTOOLS PAGE's onChanged fired too");
  expect(/\[background worker\] session\.onChanged \(per-area\): counter, by/.test(heardA), "A: per-area storage.session.onChanged fired in the worker");
  await shot(frontend, "02-panel-a-background-and-devtools-heard.png");

  // ── 03 ────────────────────────────────────────────────────────────────────
  await evaluate(a, `document.getElementById("options").click()`);
  const optionsTarget = await targetWith((t) => t.url === "rozenite://storage-demo-a/options.html");
  const options = await connect(optionsTarget.webSocketDebuggerUrl);
  await sleep(1200);
  const optionsBefore = await text(options, "snapshot");
  expect(/"counter": 1/.test(optionsBefore), "A: the options page READ the value the panel wrote before it existed");
  await evaluate(a, `document.getElementById("write").click()`);
  await sleep(1200);
  const optionsHeard = await text(options, "heard");
  console.log(`options heard:\n${optionsHeard}`);
  expect(/session\.counter: 1 -> 2/.test(optionsHeard), "A: the options page's onChanged saw counter 1 -> 2 (oldValue/newValue)");
  await shot(options, "03-options-page-a-read-and-heard.png");
  const heardA2 = await text(a, "heard");
  expect(/\[options page\] session\.counter: 1 -> 2/.test(heardA2), "A: the panel's list now includes the options page's report");
  await shot(frontend, "03b-panel-a-all-contexts-heard.png");

  // ── 04 ────────────────────────────────────────────────────────────────────
  await clickTab(frontend, "tab-ext.storage-demo-b.panel.html");
  const b = await panelOf("storage-demo-b");
  await sleep(500);
  const snapshotB = (await text(b, "snapshot")).trim();
  expect(snapshotB === "{}", "B: a different extension reads NOTHING of A's session storage");
  expect((await text(b, "heard")).includes("nothing yet"), "B: none of B's contexts heard A's changes");
  await shot(frontend, "04-panel-b-sees-nothing-of-a.png");

  // ── 05 ────────────────────────────────────────────────────────────────────
  await evaluate(b, `document.getElementById("write").click()`);
  await sleep(1200);
  const heardB = await text(b, "heard");
  console.log(`B heard:\n${heardB}`);
  expect(/\[background worker\] session\.counter: \(absent\) -> 1/.test(heardB), "B: B's worker heard B's own write (counter absent -> 1, not 2 -> 1)");
  expect(!/-> 2/.test(heardB), "B: and nothing from A's counter");
  await shot(frontend, "05-panel-b-own-write.png");

  // ── 06 ────────────────────────────────────────────────────────────────────
  // Switching tabs destroys and recreates a panel's iframe, so this is a NEW panel page
  // (fresh context, empty heard-list) reading the session value the old one left in the
  // host's store: the value belongs to the extension, not to the frame that wrote it.
  await clickTab(frontend, "tab-ext.storage-demo-a.panel.html");
  a.close();
  const a2 = await panelOf("storage-demo-a");
  await sleep(800);
  const finalA = JSON.parse(await text(a2, "snapshot"));
  expect(
    finalA.counter === 2 && finalA.by === "panel",
    `A: a freshly loaded panel reads A's own value, untouched by B's write (${JSON.stringify(finalA)})`
  );
  await shot(frontend, "06-panel-a-reloaded-reads-shared-value.png");

  // ── 07 ────────────────────────────────────────────────────────────────────
  await evaluate(a2, `document.getElementById("write").click()`);
  await sleep(1200);
  const optionsFinal = await text(options, "heard");
  console.log(`options heard (final):\n${optionsFinal}`);
  expect(
    optionsFinal.trim() === "session.counter: 1 -> 2\nsession.counter: 2 -> 3",
    "A: the options page heard only A's changes (1 -> 2, 2 -> 3) and never B's write in between"
  );
  await shot(options, "07-options-page-a-never-heard-b.png");

  fs.writeFileSync(
    path.join(OUT, "results.json"),
    JSON.stringify({ heardA: heardA2, optionsHeard, heardB, snapshotA: finalA, optionsFinal, failures }, null, 2)
  );
  frontend.close();
  a2.close();
  b.close();
  options.close();
  console.log(failures.length ? `\n${failures.length} FAILED` : "\nall checks passed");
  process.exit(failures.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(2);
});
