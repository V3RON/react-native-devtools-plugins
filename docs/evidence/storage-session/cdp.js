// Tiny CDP client for the evidence driver (uses the repo's existing `ws` dependency).
const WebSocket = require("ws");
const http = require("http");

const getJson = (url) =>
  new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve(JSON.parse(body)));
      })
      .on("error", reject);
  });

const connect = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: ok, reject: bad } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
      } else if (msg.method) {
        listeners.forEach((fn) => fn(msg));
      }
    });
    ws.on("open", () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((ok, bad) => {
            id += 1;
            pending.set(id, { resolve: ok, reject: bad });
            ws.send(JSON.stringify({ id, method, params }));
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      })
    );
    ws.on("error", reject);
  });

/** Evaluate an expression in a target and return its value. */
const evaluate = async (client, expression) => {
  const res = await Promise.race([
    client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, bad) => setTimeout(() => bad(new Error("evaluate timed out")), 10000)),
  ]);
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
  }
  return res.result.value;
};

module.exports = { getJson, connect, evaluate };
