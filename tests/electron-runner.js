// Shared runner for the tests that boot the production shell in a real Electron
// process (tests/extension-frame-electron.test.js,
// tests/background-worker-electron.test.js).
//
// Both files need the same three things: find Electron's binary without adding a
// dependency, spawn `tests/extension-frame-harness.js` as a child Electron main,
// and read back the NDJSON it observed. Having one copy is the point — a harness
// contract change has exactly one place to be wrong.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const HARNESS = path.join(__dirname, "extension-frame-harness.js");

/** Electron ships in devDependencies; resolve its binary without adding anything. */
const electronBinary = () => {
  try {
    const resolved = require("electron");
    return typeof resolved === "string" ? resolved : null;
  } catch {
    return null;
  }
};

const readLines = (out) => {
  try {
    return fs
      .readFileSync(out, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { kind: "unparseable", line: line.slice(0, 300) };
        }
      });
  } catch {
    return [];
  }
};

/**
 * Run the production shell headless against `extensionsDir`, hosting whatever
 * `hostPage` says. The host page is generated here (never committed) because the
 * frontend's real role in this story is only "an http:// document that embeds a
 * rozenite:// iframe".
 *
 * `userDataDir` defaults to a folder under `root`; a caller that wants to observe
 * a SECOND launch of the same install (install → update → startup) passes the
 * first run's directory back in.
 */
const runHarness = ({
  binary,
  root,
  extensionsDir,
  hostPage,
  page = "host.html",
  waitFor = "",
  timeoutMs = 45000,
  settleMs = 900,
  backgroundHost = false,
  extensionId = "",
  userDataDir,
  extraArgs = [],
}) => {
  const hostDir = path.join(root, "frontend");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, page), hostPage);
  fs.mkdirSync(root, { recursive: true });

  const out = path.join(root, "observed.ndjson");
  fs.writeFileSync(out, "");
  const args = [
    HARNESS,
    `--extensions-dir=${extensionsDir}`,
    `--host-dir=${hostDir}`,
    `--out=${out}`,
    `--user-data-dir=${userDataDir || path.join(root, "userData")}`,
    `--page=${page}`,
    `--timeout=${Math.floor(timeoutMs / 2)}`,
    `--settle=${settleMs}`,
    ...extraArgs,
  ];
  if (waitFor) {
    args.push(`--wait-for=${waitFor}`);
  }
  if (extensionId) {
    args.push(`--extension-id=${extensionId}`);
  }
  if (backgroundHost) {
    args.push("--background-host=on");
  }

  const child = spawn(binary, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, output: output.slice(-4000), out, userDataDir: args[4].split("=")[1] });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: "timeout", observed: readLines(out) });
    }, timeoutMs);
    child.on("close", (code) => finish({ code, observed: readLines(out) }));
  });
};

/** Stage a folder tree into `<extensionsDir>/<id>`, manifest included. */
const stageExtension = (extensionsDir, id, files) => {
  const root = path.join(extensionsDir, id);
  fs.mkdirSync(root, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
};

/** Console lines of one NDJSON log, for the "what did it actually say" dumps. */
const consoleLines = (observed) =>
  observed
    .filter((line) => line.kind === "console" || line.kind === "worker-console")
    .map((line) => `${line.kind === "worker-console" ? `[worker ${line.extensionId}] ` : ""}${line.message}`);

module.exports = { REPO, HARNESS, electronBinary, readLines, runHarness, stageExtension, consoleLines };
