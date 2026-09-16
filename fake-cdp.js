const WebSocket = require("ws");
const { default: fetch } = require("node-fetch");

// Config: point this to your real Chrome instance
const CHROME_HOST = "localhost";
const CHROME_PORT = 9222;

(async () => {
  // 1. Get the real CDP WebSocket URL from Chrome
  const versionRes = await fetch(`http://${CHROME_HOST}:${CHROME_PORT}/json`);
  const versionJson = await versionRes.json();
  const realWsUrl = versionJson.find(
    (version) =>
      version.type === "page" && version.url === "http://localhost:8081/"
  ).webSocketDebuggerUrl;
  console.log(realWsUrl);

  // 2. Connect to the real Chrome instance
  const realWs = new WebSocket(realWsUrl);

  // 3. Start our fake CDP server for RN DevTools to connect to
  const server = new WebSocket.Server({ port: 9223 });

  console.log("Fake CDP server running on ws://localhost:9223");

  server.on("connection", (client) => {
    console.log("RN DevTools connected");

    // Forward messages from RN DevTools to real Chrome
    client.on("message", (msg) => {
      const data = JSON.parse(msg);

      // if (data.method === "Runtime.evaluate") {
      //   console.log(data);
      // }

      // // Intercept ReactNativeApplication domain requests
      // if (
      //   data.method &&
      //   data.method.startsWith("ReactNativeApplication.enable")
      // ) {
      //   console.log("ReactNativeApplication.enable");
      //   // Fake response: always succeed with empty result
      //   client.send(
      //     '{"params":{"appDisplayName":"Expo","appIdentifier":"host.exp.Exponent","deviceName":"iPhone 16","integrationName":"ios Bridgeless (RCTHost)","platform":"ios","reactNativeVersion":"0.79.6","unstable_isProfilingBuild":false,"unstable_networkInspectionEnabled":false},"method":"ReactNativeApplication.metadataUpdated"}'
      //   );
      //   return;
      // }

      console.log({ type: "request", data });
      // Forward everything else to real Chrome
      realWs.send(JSON.stringify(data));
    });

    // Forward real Chrome responses back to RN DevTools
    realWs.on("message", (msg) => {
      console.log({
        type: "response",
        data: JSON.parse(msg),
      });
      client.send(JSON.stringify(JSON.parse(msg)));
    });
  });
})();
