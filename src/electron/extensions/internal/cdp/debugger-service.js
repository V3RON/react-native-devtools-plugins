// chrome.debugger, in the main process (docs/features/DEBUGGER.md).
//
// Each attached extension gets its OWN debugger session to the inspected app: a fresh
// ./cdp-session.js, dialled to the same `ws=` as the host's session, with the same Origin
// and the same `supportsMultipleDebuggers` check. React Native's backend keeps sessions
// apart (jsinspector-modern: a domain enabled on one session reports to that session), so
// what an extension enables, the events it gets back, and what it turns off again never
// touch the frontend's session or the host's.
//
// Commands are FORWARDED, not curated. Whatever method an extension sends goes to the app,
// and the app's answer comes back as it was: a result, or the backend's own error object
// (React Native answers an unknown method with -32601 "Unsupported method"). There is no
// list of supported domains here to fall out of step with React Native, and Chrome's own
// domain restriction is not copied either: it exists to keep extensions away from browser
// internals this host does not have.
//
// What this module does own is the API's contract with the extension:
//   - one attachment per extension, refused like Chrome refuses a second one;
//   - a debuggee names the inspected app: its tab id (the extension's
//     `chrome.devtools.inspectedWindow.tabId`) or its target id (from getTargets);
//   - the attachment ends with its socket. A session the app closed fires onDetach with
//     "target_closed" and is not dialled again, because the domains the extension had
//     enabled died with it. `detach()` ends it quietly, as in Chrome;
//   - no command timeout (Chrome has none): a command fails when the app answers with an
//     error or when the attachment ends.
//
// Nothing here throws across IPC: every call resolves `{ok: true, result}` or
// `{ok: false, error}` with the message Chrome would put in runtime.lastError.
//
// No Electron: the session factory and the delivery are injected, so
// tests/debugger-service.test.js runs this against a fake inspector proxy in-process.

// Chrome's protocol versions for `attach(target, requiredVersion)`.
const SUPPORTED_VERSION = /^1\.[0-3]$/;

/** The description Chrome puts in "attached to the <kind> with id: <id>". */
const describe = (debuggee) =>
  debuggee.targetId !== undefined
    ? `target with id: ${debuggee.targetId}`
    : `tab with id: ${debuggee.tabId}`;

/**
 * @param {object} deps
 * @param {(extensionId: string) => object} deps.createSession a NEW, single-shot, untimed
 *        CDP session (./cdp-session.js createCdpSession with `reconnect: false`)
 * @param {() => (string|null)} deps.getFrontendUrl the frontend URL whose `ws=` names the
 *        inspected app; null while no window is attached
 * @param {() => Promise<{attached: boolean, id?: string, url?: string, title?: string}>}
 *        deps.describeTarget what the host knows about the inspected app
 * @param {(extensionId: string) => number} deps.tabIdFor the extension's inspectedWindow.tabId
 * @param {(extensionId: string, delivery: object) => void} deps.deliver push to every
 *        context of that extension
 * @param {(level: string, message: string) => void} [deps.log]
 */
const createDebuggerService = ({
  createSession,
  getFrontendUrl,
  describeTarget,
  tabIdFor,
  deliver,
  log = () => {},
}) => {
  /** extensionId -> {session, debuggee, ready} */
  const attachments = new Map();

  /**
   * Which app a debuggee names, checked against what this host has.
   * @returns {Promise<{ok: true, debuggee: object} | {ok: false, error: string}>}
   */
  const resolveDebuggee = async (extensionId, target) => {
    if (!target || typeof target !== "object") {
      return { ok: false, error: "Either tab id or extension id must be specified." };
    }
    if (target.extensionId !== undefined) {
      return {
        ok: false,
        error: `Cannot attach to the extension with id: ${target.extensionId}. Only the inspected app can be debugged here.`,
      };
    }
    if (target.targetId !== undefined) {
      const info = await describeTarget();
      if (!info.attached || info.id === undefined || String(target.targetId) !== String(info.id)) {
        return { ok: false, error: `No target with given id ${target.targetId}.` };
      }
      return { ok: true, debuggee: { targetId: info.id } };
    }
    if (target.tabId !== undefined) {
      if (target.tabId !== tabIdFor(extensionId)) {
        return { ok: false, error: `No tab with given id ${target.tabId}.` };
      }
      return { ok: true, debuggee: { tabId: target.tabId } };
    }
    return { ok: false, error: "Either tab id or extension id must be specified." };
  };

  /** The attachment a call names, or Chrome's "not attached" answer. */
  const attachmentFor = async (extensionId, target) => {
    const resolved = await resolveDebuggee(extensionId, target);
    if (!resolved.ok) {
      return resolved;
    }
    const attachment = attachments.get(extensionId);
    if (!attachment || !attachment.ready) {
      return { ok: false, error: `Debugger is not attached to the ${describe(resolved.debuggee)}.` };
    }
    return { ok: true, attachment };
  };

  const attach = async (extensionId, target, requiredVersion) => {
    const resolved = await resolveDebuggee(extensionId, target);
    if (!resolved.ok) {
      return resolved;
    }
    const { debuggee } = resolved;
    if (requiredVersion !== undefined && !SUPPORTED_VERSION.test(String(requiredVersion))) {
      return { ok: false, error: `Requested protocol version is not supported: ${requiredVersion}.` };
    }
    if (attachments.has(extensionId)) {
      return { ok: false, error: `Another debugger is already attached to the ${describe(debuggee)}.` };
    }
    const frontendUrl = getFrontendUrl();
    if (!frontendUrl) {
      return { ok: false, error: `Cannot attach to the ${describe(debuggee)}: no app is being inspected.` };
    }

    const session = createSession(extensionId);
    // Reserved before the dial, so a second attach while this one connects is refused.
    const attachment = { session, debuggee, ready: false };
    attachments.set(extensionId, attachment);

    session.onEvent("*", (params, method, sessionId) => {
      if (attachments.get(extensionId) !== attachment) {
        return;
      }
      const source = sessionId === undefined ? { ...debuggee } : { ...debuggee, sessionId };
      deliver(extensionId, { kind: "debugger", payload: { type: "event", source, method, params } });
    });
    session.onDetach((reason) => {
      if (attachments.get(extensionId) !== attachment) {
        return;
      }
      attachments.delete(extensionId);
      log("info", `${extensionId}: the app closed the debugger session (${reason})`);
      deliver(extensionId, {
        kind: "debugger",
        payload: { type: "detach", source: { ...debuggee }, reason: "target_closed" },
      });
    });

    const opened = await session.open(frontendUrl);
    if (attachments.get(extensionId) !== attachment) {
      // Detached (or the host went away) while connecting.
      session.close();
      return { ok: false, error: `Cannot attach to the ${describe(debuggee)}: detached while attaching.` };
    }
    if (!opened) {
      attachments.delete(extensionId);
      const why = session.status().reason || "the debugger session did not open";
      session.close();
      return { ok: false, error: `Cannot attach to the ${describe(debuggee)}: ${why}.` };
    }
    attachment.ready = true;
    log("info", `${extensionId}: attached its own debugger session`);
    return { ok: true };
  };

  const detach = async (extensionId, target) => {
    const found = await attachmentFor(extensionId, target);
    if (!found.ok) {
      return found;
    }
    attachments.delete(extensionId);
    found.attachment.session.close();
    log("info", `${extensionId}: detached its debugger session`);
    return { ok: true };
  };

  const sendCommand = async (extensionId, target, method, params) => {
    if (typeof method !== "string" || method.length === 0) {
      return { ok: false, error: "sendCommand: method must be a non-empty string." };
    }
    if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
      return { ok: false, error: "sendCommand: commandParams must be an object." };
    }
    const found = await attachmentFor(extensionId, target);
    if (!found.ok) {
      return found;
    }
    const sessionId = target && target.sessionId !== undefined ? target.sessionId : undefined;
    try {
      const result = await found.attachment.session.sendCommand(method, params, { sessionId });
      return { ok: true, result: result === undefined ? {} : result };
    } catch (error) {
      if (error && error.cdpError) {
        // Chrome reports the backend's error object, serialized, as lastError.message.
        return { ok: false, error: JSON.stringify(error.cdpError) };
      }
      if (error && error.code === "DETACHED") {
        return { ok: false, error: "Detached while handling command." };
      }
      return { ok: false, error: (error && error.message) || "sendCommand failed" };
    }
  };

  const getTargets = async (extensionId) => {
    const info = await describeTarget();
    if (!info.attached) {
      return { ok: true, result: [] };
    }
    return {
      ok: true,
      result: [
        {
          type: "page",
          id: info.id === undefined ? "" : String(info.id),
          tabId: tabIdFor(extensionId),
          title: info.title || "",
          url: info.url || "",
          // Chrome's "a debugger is attached", and the DevTools frontend always is.
          attached: true,
        },
      ],
    };
  };

  /**
   * End every attachment, telling each extension why (the host is going away, or the
   * inspected app is being replaced). @param {string} [reason] Chrome's DetachReason
   */
  const detachAll = (reason = "target_closed") => {
    for (const [extensionId, attachment] of [...attachments]) {
      attachments.delete(extensionId);
      attachment.session.close();
      if (attachment.ready) {
        deliver(extensionId, {
          kind: "debugger",
          payload: { type: "detach", source: { ...attachment.debuggee }, reason },
        });
      }
    }
  };

  return {
    attach,
    detach,
    sendCommand,
    getTargets,
    detachAll,
    isAttached: (extensionId) => Boolean(attachments.get(extensionId)?.ready),
  };
};

module.exports = { createDebuggerService, SUPPORTED_VERSION };
