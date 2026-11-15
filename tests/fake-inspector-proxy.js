// A fake dev server for the CDP session suites (tests/cdp-session.test.js,
// tests/debugger-service.test.js): Metro's `/json/list` plus an `/inspector/debug`
// debugger socket, keeping the real inspector proxy's two rules — an allowed Origin
// (InspectorProxy.js verifyClient) and the target's `supportsMultipleDebuggers`.
//
// Every connection is its own session, the way React Native's backend keeps them: a
// command is answered on the socket it came in on, and `push(message, connection)` can
// address one connection. Commands are recorded with the connection they arrived on.
const http = require("node:http");
const WebSocket = require("ws");

const startProxy = async ({ multipleDebuggers = true } = {}) => {
  const sockets = []; // every connection ever accepted, in order; index = connection number
  const commands = [];
  const origins = [];
  const refusals = new Map(); // method -> error object
  const silenced = new Set(); // methods left unanswered; "*" = all
  let connections = 0;
  const state = { multipleDebuggers };
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
          id: "dev-1",
          type: "node",
          title: "fake-app",
          webSocketDebuggerUrl: `ws://localhost:${server.address().port}/inspector/debug?device=dev&page=1`,
          reactNative: { capabilities: { supportsMultipleDebuggers: state.multipleDebuggers } },
        },
      ])
    );
  });
  const wss = new WebSocket.Server({
    server,
    path: "/inspector/debug",
    verifyClient: ({ origin }) => {
      origins.push(origin || null);
      try {
        return ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
      } catch {
        return false;
      }
    },
  });
  wss.on("connection", (socket) => {
    const connection = connections;
    connections += 1;
    sockets.push(socket);
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      commands.push({ ...message, connection });
      if (silenced.has("*") || silenced.has(message.method)) return;
      const refusal = refusals.get(message.method);
      socket.send(
        JSON.stringify(
          refusal
            ? { id: message.id, error: refusal }
            : { id: message.id, result: { echo: message.method } }
        )
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const frontendUrl = new URL(`http://127.0.0.1:${port}/rozenite/rn_fusebox.html`);
  frontendUrl.searchParams.set("ws", `127.0.0.1:${port}/inspector/debug?device=dev&page=1`);
  const open = () => sockets.filter((socket) => socket.readyState === WebSocket.OPEN);
  return {
    port,
    frontendUrl: frontendUrl.href,
    state,
    commands: (method) => commands.filter((entry) => !method || entry.method === method),
    origins,
    connections: () => connections,
    /** How many connections are open right now. */
    openConnections: () => open().length,
    /** Answer `method` with a CDP error: a message string, or a whole error object. */
    refuse: (method, error) =>
      refusals.set(method, typeof error === "string" ? { code: -32601, message: error } : error),
    /** Stop answering `method` (or every method, without one). */
    silence: (method = "*") => {
      silenced.add(method);
    },
    /** To every open connection, or to connection number `connection` alone. */
    push: (message, connection) => {
      const targets = connection === undefined ? open() : [sockets[connection]].filter(Boolean);
      for (const socket of targets) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      }
    },
    /** Drop every connection, or connection number `connection` alone. */
    drop: (connection) => {
      for (const socket of connection === undefined ? sockets : [sockets[connection]]) {
        if (socket) socket.terminate();
      }
    },
    dropAll: () => {
      for (const socket of sockets) socket.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close(() => server.close(resolve));
      }),
  };
};

module.exports = { startProxy };
