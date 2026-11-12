// Range requests and streamed media from an extension's own origin, in a real Electron
// process (src/electron/extensions/internal/scheme/extension-server.js, ./range.js).
//
// What an extension page sees: `fetch` with a `Range` header gets 206 + Content-Range,
// an unsatisfiable range gets 416, and a <video> of its own can seek. The video is a
// 20-second VP9 WebM of about 560 KB (tests/fixtures/media/seek.webm, ffmpeg's testsrc),
// loaded with preload="metadata" and sought to 18 s, so the seek needs bytes the media
// pipeline has not fetched yet.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { electronBinary, runHarness, stageExtension, consoleLines } = require("./electron-runner");

const binary = electronBinary();
const suite = binary ? test : test.skip;
const ID = "range.local";

const probe = `
const report = (key, value) => console.log("RANGE:" + key + "=" + JSON.stringify(value));
(async () => {
  const partial = await fetch("data.txt", { headers: { Range: "bytes=2-5" } });
  report("partial", {
    status: partial.status,
    range: partial.headers.get("content-range"),
    length: partial.headers.get("content-length"),
    body: await partial.text(),
  });
  const whole = await fetch("data.txt");
  report("whole", {
    status: whole.status,
    accept: whole.headers.get("accept-ranges"),
    body: await whole.text(),
    csp: Boolean(whole.headers.get("content-security-policy")),
  });
  const suffix = await fetch("data.txt", { headers: { Range: "bytes=-3" } });
  report("suffix", { status: suffix.status, body: await suffix.text() });
  const beyond = await fetch("data.txt", { headers: { Range: "bytes=100-" } });
  report("unsatisfiable", { status: beyond.status, range: beyond.headers.get("content-range") });

  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.addEventListener("error", () => {
    report("video", { error: video.error && video.error.code });
    report("done", true);
  });
  video.addEventListener("loadedmetadata", () => {
    report("meta", { duration: video.duration });
    video.currentTime = 18;
  });
  video.addEventListener("seeked", () => {
    report("video", { currentTime: video.currentTime });
    report("done", true);
  });
  video.src = "seek.webm";
  document.body.appendChild(video);
})().catch((error) => {
  report("error", String(error));
  report("done", true);
});
setTimeout(() => report("done", "timeout"), 15000);
`;

const hostPage = `<!DOCTYPE html><html><body>
  <iframe src="rozenite://${ID}/panel.html" width="400" height="300"></iframe>
</body></html>`;

suite("range requests and media seeking from an extension's origin", { timeout: 180000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rozenite-range-electron-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const extensionsDir = path.join(root, "extensions");
  stageExtension(extensionsDir, ID, {
    "manifest.json": JSON.stringify({ name: "Range", version: "1", manifest_version: 3 }),
    "panel.html": '<!DOCTYPE html><html><head><script src="panel.js"></script></head><body></body></html>',
    "panel.js": probe,
    "data.txt": "0123456789",
    "seek.webm": fs.readFileSync(path.join(__dirname, "fixtures", "media", "seek.webm")),
  });

  const run = await runHarness({
    binary,
    root: path.join(root, "run"),
    extensionsDir,
    hostPage,
    extensionId: ID,
    waitFor: "RANGE:done=",
    timeoutMs: 90000,
    settleMs: 300,
  });
  const lines = consoleLines(run.observed).map(String);
  const reported = {};
  for (const line of lines) {
    const match = /RANGE:(\w+)=(.*)$/.exec(line);
    if (match && !(match[1] in reported)) reported[match[1]] = JSON.parse(match[2]);
  }
  const dump = `exit ${run.code}\n${lines.slice(-20).join("\n")}`;

  assert.strictEqual(reported.error, undefined, `no probe error\n${dump}`);
  assert.deepStrictEqual(
    reported.partial,
    { status: 206, range: "bytes 2-5/10", length: "4", body: "2345" },
    `a byte range is answered with 206 and exactly those bytes\n${dump}`
  );
  assert.deepStrictEqual(
    reported.whole,
    { status: 200, accept: "bytes", body: "0123456789", csp: true },
    `a plain request advertises ranges and keeps the extension's CSP\n${dump}`
  );
  assert.deepStrictEqual(reported.suffix, { status: 206, body: "789" }, `a suffix range is the last bytes\n${dump}`);
  assert.deepStrictEqual(
    reported.unsatisfiable,
    { status: 416, range: "bytes */10" },
    `a range past the end is 416 with the size\n${dump}`
  );
  assert.ok(reported.meta && Math.abs(reported.meta.duration - 20) < 0.2, `the video's metadata loaded\n${dump}`);
  assert.ok(
    reported.video && typeof reported.video.currentTime === "number" && Math.abs(reported.video.currentTime - 18) < 0.2,
    `the video seeked to 18s, past what it had loaded: ${JSON.stringify(reported.video)}\n${dump}`
  );
});
