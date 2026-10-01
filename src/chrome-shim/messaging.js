// Frame-side runtime messaging client: implements chrome.runtime.sendMessage
// and connect() against the host router via an injected transport
// (docs/features/RUNTIME-MESSAGING.md).
//
// Transport interface (async):
//   sendMessage({message})       -> Promise<response>   (router round-trip)
//   respond({requestId, response})                      (complete an inbound leg)
//   connect({name})              -> Promise<{ok, portId} | {ok:false, error}>
//   portPost({portId, message})  -> Promise
//   portClose({portId})          -> Promise
//
// Incoming deliveries arrive via onDelivery({kind, payload}) with kinds:
//   message | port-connect | port-message | port-disconnect.
//
// Chrome contract rules honored here:
//   - promise AND callback dual style (callback form returns undefined);
//   - lastError set (only) around the callback that may observe it;
//   - onMessage listeners: return true = async response via sendResponse
//     (exactly-once guard); anything else = sync, empty response;
//   - Port with onMessage/onDisconnect, disconnect(), lastError on failure.
const { createEvent } = require("./event");

const createMessagingClient = ({ extensionId, transport, runtimeEvents, lastError }) => {
  const ports = new Map(); // portId -> Port
  let nextLocalPortId = 1;

  const withLastError = (error, fn) => {
    lastError.value = error;
    try {
      return fn();
    } finally {
      lastError.value = null;
    }
  };

  // ── outbound sendMessage ─────────────────────────────────────────────────
  // Chrome overloads (positional disambiguation):
  //   sendMessage(message, [options], [callback])
  //   sendMessage(extensionId, message, [options], [callback])
  // A lone leading string is the message; a leading string only counts as an
  // extensionId when another message argument follows it.
  const parseSendArgs = (rawArgs) => {
    const args = [...rawArgs];
    const callback = typeof args[args.length - 1] === "function" ? args.pop() : undefined;
    let targetId;
    if (typeof args[0] === "string" && args.length >= 2) {
      targetId = args.shift();
    }
    const message = args.shift();
    const options = args.shift(); // accepted, ignored (includeTlsChannelId, ...)
    return { targetId, message, options, callback };
  };

  const sendMessage = (...rawArgs) => {
    const { targetId, message, options, callback } = parseSendArgs(rawArgs);
    // External/other-extension messaging is out of scope (single-tenant):
    // only our own extension id (or none) resolves; anything else fails like
    // Chrome's "Could not establish connection.".
    if (targetId !== undefined && targetId !== extensionId) {
      const failure = Promise.reject(
        new Error("Could not establish connection. Receiving end does not exist.")
      );
      if (callback) {
        failure.catch(() => {});
        withLastError({ message: "Could not establish connection. Receiving end does not exist." }, () =>
          callback()
        );
        return undefined;
      }
      return failure;
    }

    const promise = transport.sendMessage({ message, options }).then((response) => {
      if (callback) {
        withLastError(null, () => callback(response));
      }
      return response;
    });
    return callback ? undefined : promise;
  };

  // ── inbound message dispatch (onMessage + sendResponse) ─────────────────
  const handleInboundMessage = ({ requestId, message, sender }) => {
    let responded = false;
    const sendResponse = (response) => {
      if (responded) {
        return; // Chrome: only the first sendResponse reaches the sender
      }
      responded = true;
      transport.respond({ requestId, response });
    };
    const returns = runtimeEvents.onMessage._fire(message, sender, sendResponse);
    // No listener claimed async -> conclude the leg immediately (empty
    // response), matching Chrome's sync-path behavior.
    if (!returns.includes(true) && !responded) {
      sendResponse(undefined);
    }
  };

  // ── Ports ────────────────────────────────────────────────────────────────
  const makePort = ({ portId, name, initiator, upgradeable = false }) => {
    // An initiated port starts on a local placeholder id and Chrome's
    // `postMessage` is legal immediately after `connect()`. The real id only
    // exists when connect()'s round-trip resolves, so posts made in that window
    // are queued and flushed rather than dropped on an id the router has never
    // heard of.
    const queue = upgradeable ? [] : null;
    let closed = false;
    const port = {
      name,
      portId,
      // Chrome exposes sender on the receiving side only.
      ...(initiator ? { sender: initiator } : {}),
      onMessage: createEvent(),
      onDisconnect: createEvent(),
      // Read port.portId late: for initiated ports it upgrades from the
      // local placeholder to the router-assigned id once connect() resolves.
      disconnect: () => {
        closed = true;
        if (queue) {
          queue.length = 0; // nothing queued may escape a closed port
        }
        if (ports.delete(port.portId)) {
          transport.portClose({ portId: port.portId });
        }
      },
      postMessage: (message) => {
        if (!queue) {
          return transport.portPost({ portId: port.portId, message });
        }
        if (closed || String(port.portId).startsWith("pending-")) {
          if (!closed) {
            queue.push(message);
          }
          return undefined;
        }
        return transport.portPost({ portId: port.portId, message });
      },
      // Internal: connect() resolved, flush what was posted early.
      _adoptRealId: (realPortId) => {
        port.portId = realPortId;
        if (closed) {
          // disconnect() ran while the id was still a placeholder; the router's
          // port exists by now, so close it instead of adopting it quietly.
          transport.portClose({ portId: realPortId });
          return;
        }
        ports.set(realPortId, port);
        if (!queue) {
          return;
        }
        for (const message of queue.splice(0, queue.length)) {
          transport.portPost({ portId: realPortId, message });
        }
      },
    };
    return port;
  };

  const connect = (...args) => {
    const targetId = args.find((a) => typeof a === "string");
    const connectInfo = args.find((a) => a && typeof a === "object");
    if (targetId !== undefined && targetId !== extensionId) {
      throw new Error("Extension messaging outside this extension is not supported.");
    }
    const name = connectInfo && connectInfo.name ? connectInfo.name : "";
    // Local placeholder port immediately (Chrome returns synchronously); the
    // real portId/round-trip resolves underneath.
    const port = makePort({
      portId: `pending-${nextLocalPortId++}`,
      name,
      upgradeable: true,
    });
    transport
      .connect({ name })
      .then((result) => {
        if (!result.ok) {
          port.lastError = { message: result.error };
          port.onDisconnect._fire(port);
          return;
        }
        port._adoptRealId(result.portId);
      })
      .catch(() => {
        port.lastError = { message: "Could not establish connection." };
        port.onDisconnect._fire(port);
      });
    return port;
  };

  // ── incoming deliveries from the host ────────────────────────────────────
  const handleDelivery = ({ kind, payload }) => {
    switch (kind) {
      case "message":
        handleInboundMessage(payload);
        break;
      case "port-connect": {
        const port = makePort(payload);
        ports.set(payload.portId, port);
        runtimeEvents.onConnect._fire(port);
        break;
      }
      case "port-message": {
        const port = ports.get(payload.portId);
        if (port) {
          withLastError(null, () => port.onMessage._fire(payload.message, payload.from));
        }
        break;
      }
      case "port-disconnect": {
        const port = ports.get(payload.portId);
        if (port) {
          ports.delete(payload.portId);
          port.lastError = { message: "Port disconnected" }; // deviation: Chrome varies by cause
          port.onDisconnect._fire(port);
        }
        break;
      }
      default:
        break;
    }
  };

  const api = { sendMessage, connect };
  return { ...api, namespace: api, handleDelivery };
};

module.exports = { createMessagingClient };
