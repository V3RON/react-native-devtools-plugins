// `chrome.tabs.sendMessage`'s host half, apart from the IPC plumbing that cannot be
// unit-tested (docs/features/CONTENT-SCRIPTS.md, GitHub issue #5).
//
// The rule this file exists to keep testable is that NOTHING here trusts the payload:
// the addressed app context comes from the CALLING FRAME's own extension id, and the
// answer a caller gets comes from the mesh. A payload that names another extension, or
// a tab id that would address something else, has no way in — Chrome addresses a tab,
// and in this shell the only addressable target is the caller's own app context.
//
// It is also where the two failure shapes are decided, and they are not interchangeable:
//   - refusal (nothing was reached): `{ok: false, error}`, because there is no answer;
//   - silence (the context was reached and nothing listens): the mesh rejects, and that
//     rejection becomes the same refusal shape, with the app's own reason.
// What never happens is `{ok: true, response: undefined}` for a context that answered
// nothing — the shape an extension reads as "the page replied with nothing".

/** The calling frame's extension id, from its own url. `rozenite://<id>/…` by construction. */
const extensionIdOfFrame = (frameUrl) => {
  try {
    return new URL(frameUrl).hostname || null;
  } catch {
    return null;
  }
};

/**
 * @param {object} args
 * @param {boolean} args.granted the caller's `tabs` grant, from host state
 * @param {string} args.frameUrl the calling frame's url (identity, never the payload)
 * @param {object|null} args.bridge the content bridge, or null when none is running
 * @param {string} args.fromKey the verified calling frame's key in the mesh
 * @param {(details: {fromKey: string, targetKey: string, message: unknown}) =>
 *   {ok: boolean, error?: string, requestId?: number, promise?: Promise<unknown>}} args.sendTo
 * @param {unknown} args.message
 * @returns {Promise<{ok: true, response: unknown}|{ok: false, error: string}>}
 */
const deliverTabMessage = async ({ granted, frameUrl, bridge, fromKey, sendTo, message }) => {
  if (!granted) {
    return { ok: false, error: "tabs: permission 'tabs' is not declared" };
  }
  if (!fromKey) {
    // A frame that never registered cannot have a grant either; checked separately so a
    // registration bug reports itself instead of looking like a missing permission.
    return { ok: false, error: "tabs.sendMessage: the calling frame is not registered" };
  }
  if (!bridge) {
    return {
      ok: false,
      error:
        "tabs.sendMessage: this shell has no content bridge running, so nothing can receive this message",
    };
  }
  const extensionId = extensionIdOfFrame(frameUrl);
  if (!extensionId) {
    return { ok: false, error: "tabs.sendMessage: the calling frame has no extension id" };
  }
  const target = bridge.tabTarget({ extensionId });
  if (!target.ok) {
    return { ok: false, error: target.error };
  }
  const send = sendTo({ fromKey, targetKey: target.frameKey, message });
  if (!send.ok) {
    return { ok: false, error: send.error };
  }
  // Rejection IS an honest answer here: the addressed context said nothing is listening
  // in it, or was gone by the time the message got there.
  return Promise.resolve(send.promise).then(
    (response) => ({ ok: true, response }),
    (error) => ({ ok: false, error: error.message })
  );
};

module.exports = { deliverTabMessage, extensionIdOfFrame };
