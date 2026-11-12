// Which app the development shell debugs, and the frontend URL that says so.
//
// Upstream, dev-middleware launches the shell with `--frontendUrl=…?ws=<target>` and the
// shell never picks a target. This repository's shell is started by hand (`npm start`),
// so it does that one job itself: poll Metro's `/json/list`, take the first React Native
// target that passes the app/device filters, and put its debugger URL in `?ws=`. The
// frontend then dials Metro's inspector proxy directly, and the extension host opens its
// own second session to the same target (src/electron/extensions/internal/cdp/cdp-session.js).
//
// DEVTOOLS_FRONTEND_URL that already names a `ws=`/`wss=` is used as it is.
//
// Not ported: this is the development shell's stand-in for dev-middleware's launch.

/** The frontend URL for one `/json/list` entry. Pure. */
const frontendURLFor = (entry, frontendBase) => {
  const url = new URL(frontendBase);
  const debuggerUrl = String(entry.webSocketDebuggerUrl);
  const secure = debuggerUrl.startsWith("wss://");
  url.searchParams.delete("ws");
  url.searchParams.delete("wss");
  url.searchParams.set(secure ? "wss" : "ws", debuggerUrl.replace(/^wss?:\/\//, ""));
  return url.href;
};

/** Does the configured URL already name its debugger? Pure. */
const namesDebugger = (frontendURL) => {
  try {
    const { searchParams } = new URL(String(frontendURL));
    return searchParams.has("ws") || searchParams.has("wss");
  } catch {
    return false;
  }
};

/** The first entry that is a React Native target and passes the filters. Pure. */
const pickTarget = (entries, { app = null, device = null } = {}) =>
  (Array.isArray(entries) ? entries : []).find(
    (entry) =>
      entry &&
      entry.type === "node" &&
      typeof entry.webSocketDebuggerUrl === "string" &&
      (!app || String(entry.description || entry.appId || "").includes(app)) &&
      (!device || String(entry.deviceName || "").includes(device))
  ) || null;

/**
 * Resolve the URL to load: the configured one when it names a debugger, otherwise the
 * frontend page with the first matching target's `ws=`. Waits for Metro and an app.
 *
 * @param {object} options
 * @param {string} options.frontendURL the configured page (DEVTOOLS_FRONTEND_URL or the default)
 * @param {{metroHost: string, metroPort: number, app?: string|null, device?: string|null}} options.target
 * @param {number} [options.pollIntervalMs]
 * @param {Function} [options.fetch]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<string>}
 */
const resolveFrontendURL = async ({
  frontendURL,
  target,
  pollIntervalMs = 1500,
  fetch = globalThis.fetch,
  log = (message) => console.log(`[shell] ${message}`),
}) => {
  if (namesDebugger(frontendURL)) {
    return frontendURL;
  }
  const listURL = `http://${target.metroHost}:${target.metroPort}/json/list`;
  let announced = false;
  for (;;) {
    try {
      const response = await fetch(listURL);
      const found = pickTarget(await response.json(), target);
      if (found) {
        log(`debugging ${found.title || found.id}`);
        return frontendURLFor(found, frontendURL);
      }
    } catch {
      // Metro is not up yet.
    }
    if (!announced) {
      announced = true;
      log(`waiting for a React Native app on ${listURL}…`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
};

module.exports = { resolveFrontendURL, frontendURLFor, namesDebugger, pickTarget };
