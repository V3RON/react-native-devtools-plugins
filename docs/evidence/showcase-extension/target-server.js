// Tiny inspected-target page for the showcase verification: serves a page that
// fetches a few URLs on load, so the Network cards have traffic.
//   node target-server.js <port> [chrome-debug-port]
// With a second argument it also answers /json/list like Metro's inspector proxy does
// (Chrome's page targets relabelled `type: "node"`), so the shell's own CDP bridge
// (DEVTOOLS_METRO_PORT=<port>) can attach to the headless Chromium instead of an RN app.
const http = require("http");
const port = Number(process.argv[2] || 9253);
const chromePort = Number(process.argv[3] || 0);
const page = `<!doctype html><title>Showcase target</title>
<h1>Showcase target</h1><p>Fetches /api/hello, /api/items and /missing on load.</p>
<script>
window.__showcaseValue = "hello from the inspected page";
for (const u of ["/api/hello", "/api/items", "/missing"]) fetch(u).then((r) => r.text());
</script>`;
http
  .createServer((req, res) => {
    if (req.url === "/json/list" && chromePort) {
      return http.get({ host: "127.0.0.1", port: chromePort, path: "/json/list" }, (up) => {
        let d = "";
        up.on("data", (c) => (d += c));
        up.on("end", () => {
          const list = JSON.parse(d)
            .filter((t) => t.type === "page" && t.url === `http://127.0.0.1:${port}/`)
            .map((t) => ({ ...t, type: "node", description: "showcase target" }));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(list));
        });
      });
    }
    if (req.url === "/api/hello") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ hello: "showcase", at: Date.now() }));
    }
    if (req.url === "/api/items") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ items: [1, 2, 3].map((id) => ({ id, name: "item " + id })) }));
    }
    if (req.url === "/" || req.url === "/index.html") {
      res.setHeader("content-type", "text/html");
      return res.end(page);
    }
    res.statusCode = 404;
    res.end("not found");
  })
  .listen(port, "127.0.0.1", () => console.log("target on " + port));
