// A fake inspected React Native app, for the runs that need the network delivery
// path to carry REAL CDP traffic (tests/delivery-scope.test.js).
//
// It is the same shape tests/network-end-to-end.test.js drives the bridge with,
// run inside the harness's Electron main process instead of a Node test process:
// Metro's `/json/list`, an `/inspector/debug` debugger socket, and the
// `Network.*` notifications an RN app emits for one XHR
// (react/networking/NetworkReporter.cpp:57 reports a request together with its
// headers, so requestWillBeSent and requestWillBeSentExtraInfo come as one pair).
//
// What it is honest about:
//   - it answers every command with `{id, result: {}}`, the way the backend does
//     for a domain it accepts, so `Network.enable` really travels the wire and the
//     model's `enableState` really becomes "enabled";
//   - it emits a NEW request lifecycle on a timer, only after `Network.enable` —
//     a chatty app rather than a scripted one. That is deliberate: the test cannot
//     lose a race against a stream that keeps arriving, so "the push reached the
//     frame" stays evidence about the delivery path and never about timing;
//   - it never invents a body: `Network.getResponseBody` answers for requests it
//     really announced and refuses anything else with the backend's own wording.
//
// Nothing here is production code — it is the peer the production CDP bridge
// (src/main/cdp-bridge.js) talks to, and it binds 127.0.0.1 only.
//
// This file is also the single home of the CDP lifecycle SHAPE
// (`cdpRequestLifecycle` below), which tests/network-end-to-end.test.js builds its
// own fake app's traffic from. Two suites needed the same five notifications, and a
// second copy is how the two drift into describing different backends.
const http = require("http");
const WebSocket = require("ws");

/**
 * The five CDP notifications one successful XHR produces, in the order an RN app
 * sends them (react/networking/NetworkReporter.cpp:57 reports a request together
 * with its headers, so `requestWillBeSent` and `requestWillBeSentExtraInfo` arrive
 * as one pair).
 *
 * Only the SHAPE lives here. Every number — the ids, the urls, the timestamps, the
 * byte counts — is a parameter, because in both suites that number is the thing
 * under test: `tests/network-end-to-end.test.js` asserts HAR timings and sizes read
 * back from them, and `tests/delivery-scope.test.js` asserts the frame received the
 * url the app announced. A default value here would be a value nobody chose.
 *
 * @param {object} spec
 * @param {string} spec.requestId
 * @param {string} [spec.loaderId]            defaults to the requestId
 * @param {string} spec.documentURL
 * @param {string} spec.url                   request and response url, as RN reports them
 * @param {string} spec.postData
 * @param {string} spec.userAgent             the wire header, sent with the extra info
 * @param {{started: number, wallTime: number, response: number, data: number, finished: number}} spec.timings
 *        CDP's monotonic seconds, plus the epoch wall time of the request
 * @param {{dataLength: number, encodedDataLength: number}} spec.bytes
 * @returns {object[]} the notifications, in wire order
 */
const cdpRequestLifecycle = ({
  requestId,
  loaderId = requestId,
  documentURL,
  url,
  postData,
  userAgent,
  timings,
  bytes,
}) => {
  const requestHeaders = { "content-type": "application/json" };
  return [
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId,
        loaderId,
        documentURL,
        timestamp: timings.started,
        wallTime: timings.wallTime,
        type: "XHR",
        request: {
          url,
          method: "POST",
          headers: requestHeaders,
          postData,
          hasPostData: true,
        },
        initiator: { type: "fetch", stack: { callFrames: [] } },
      },
    },
    {
      method: "Network.requestWillBeSentExtraInfo",
      params: {
        requestId,
        headers: { ...requestHeaders, "user-agent": userAgent },
      },
    },
    {
      method: "Network.responseReceived",
      params: {
        requestId,
        type: "XHR",
        timestamp: timings.response,
        response: {
          url,
          status: 200,
          statusText: "",
          httpVersion: "HTTP/1.1",
          mimeType: "application/json",
          // The body length the app says it received, in the header the app says it
          // sent: one number, because a lifecycle that disagrees with itself is a
          // fixture bug rather than a condition worth testing.
          headers: {
            "content-type": "application/json",
            "content-length": String(bytes.dataLength),
          },
          protocol: "http/1.1",
        },
      },
    },
    {
      method: "Network.dataReceived",
      params: {
        requestId,
        timestamp: timings.data,
        dataLength: bytes.dataLength,
        encodedDataLength: bytes.encodedDataLength,
      },
    },
    {
      method: "Network.loadingFinished",
      params: {
        requestId,
        timestamp: timings.finished,
        encodedDataLength: bytes.encodedDataLength,
      },
    },
  ];
};

/**
 * @param {object} options
 * @param {number} options.port           the port to serve Metro's endpoints on
 * @param {number} [options.intervalMs]   how often one request lifecycle is emitted
 * @param {(event: object) => void} [options.note] records what the app observed,
 *        in whatever form the caller's harness reports observations
 * @returns {Promise<{close: () => Promise<void>, stats: () => object}>}
 */
const startFakeRNApp = ({ port, intervalMs = 500, note = () => {} }) => {
  const sockets = new Set();
  const commands = [];
  /** every requestId this app has announced, in order */
  const announced = [];
  let timer = null;
  let cycle = 0;

  const server = http.createServer((request, response) => {
    if (!request.url.startsWith("/json/list")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        {
          id: "1",
          type: "node",
          title: "delivery-fake-app (iPhone 17 Pro)",
          description: "delivery-fake-app [C++ connection]",
          appId: "delivery-fake-app",
          deviceName: "iPhone 17 Pro",
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/inspector/debug?device=1&page=1`,
        },
      ])
    );
  });

  const send = (message) => {
    const raw = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(raw);
      }
    }
  };

  /** One request lifecycle, ids included, and the record of having sent it. */
  const emitLifecycle = () => {
    const index = cycle++;
    const requestId = `live-${index}`;
    announced.push(requestId);
    for (const message of cdpRequestLifecycle({
      requestId,
      loaderId: `loader-${index}`,
      documentURL: "rn://delivery-fake-app",
      url: `https://delivery-scope.test/live-${index}`,
      postData: `{"cycle":${index}}`,
      userAgent: "com.example.fakeapp/1.0",
      // One second per cycle on the app's monotonic clock, so two cycles of the
      // same run never share a timestamp and the model cannot merge them.
      timings: {
        started: 1000 + index,
        wallTime: 1700000000 + index,
        response: 1000.4 + index,
        data: 1000.5 + index,
        finished: 1000.6 + index,
      },
      bytes: { dataLength: 15, encodedDataLength: 120 },
    })) {
      send(message);
    }
    note({ kind: "fake-app-lifecycle", requestId, index });
  };

  const wss = new WebSocket.Server({ server, path: "/inspector/debug" });
  wss.on("connection", (socket) => {
    sockets.add(socket);
    note({ kind: "fake-app-attached" });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      commands.push(message.method);
      note({ kind: "fake-app-command", method: message.method });
      if (message.id === undefined) {
        return;
      }
      if (message.method === "Network.enable") {
        socket.send(JSON.stringify({ id: message.id, result: {} }));
        // The stream starts here, not on a timer the test has to guess: an RN app
        // reports its traffic from the moment the domain is on.
        if (!timer) {
          emitLifecycle();
          timer = setInterval(emitLifecycle, intervalMs);
        }
        return;
      }
      if (message.method === "Network.getResponseBody") {
        const id = message.params && message.params.requestId;
        socket.send(
          JSON.stringify(
            announced.includes(id)
              ? { id: message.id, result: { body: `{"cycle":"${id}"}`, base64Encoded: false } }
              : {
                  id: message.id,
                  error: {
                    code: -32603,
                    message:
                      "Network.getResponseBody: Internal error: Could not retrieve response body for the given requestId.",
                  },
                }
          )
        );
        return;
      }
      socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () =>
      resolve({
        stats: () => ({
          commands: [...commands],
          enabled: commands.includes("Network.enable"),
          announced: [...announced],
          attached: sockets.size > 0,
        }),
        close: () =>
          new Promise((closeDone) => {
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
            for (const socket of sockets) {
              socket.terminate();
            }
            sockets.clear();
            wss.close(() => server.close(closeDone));
          }),
      })
    );
  });
};

module.exports = { startFakeRNApp, cdpRequestLifecycle };
