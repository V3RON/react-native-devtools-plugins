// Minimal CDP helper used by the verification drivers (needs only `ws`).
const WebSocket = require("ws");
const http = require("http");

const getJson = (port, path = "/json") =>
  new Promise((resolve, reject) =>
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(JSON.parse(d)));
      })
      .on("error", reject)
  );

const connect = (wsUrl) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      } else if (m.method) listeners.forEach((l) => l(m));
    });
    ws.on("open", () =>
      resolve({
        send: (method, params = {}, sessionId) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { res, rej });
            ws.send(JSON.stringify({ id: i, method, params, sessionId }));
          }),
        on: (fn) => listeners.push(fn),
        close: () => ws.close(),
      })
    );
    ws.on("error", reject);
  });

/** Runtime.evaluate -> value (throws on exception). */
const evaluate = async (cdp, expression, opts = {}) => {
  const r = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    ...opts,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

const screenshot = async (cdp, file, params = {}) => {
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", ...params });
  require("fs").writeFileSync(file, Buffer.from(data, "base64"));
};

module.exports = { getJson, connect, evaluate, screenshot };
