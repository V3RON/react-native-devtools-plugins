// The broker installs its channels per WebContents (spec §5.5), never on ipcMain:
// a WebContents the host did not attach has no extension channel, and detaching
// removes exactly what was installed.
const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { createBroker } = require("../src/electron/extensions/internal/broker/ipc");
const channels = require("../src/electron/extensions/internal/broker/channels");

const fakeContents = () => {
  const contents = new EventEmitter();
  let destroyed = false;
  const handlers = new Map();
  contents.ipc = {
    handle: (channel, handler) => {
      assert.equal(handlers.has(channel), false, `${channel} installed twice`);
      handlers.set(channel, handler);
    },
    removeHandler: (channel) => handlers.delete(channel),
  };
  contents.handlers = handlers;
  contents.isDestroyed = () => destroyed;
  contents.destroy = () => {
    destroyed = true;
    contents.emit("destroyed");
  };
  return contents;
};

const makeBroker = (extra = {}) =>
  createBroker({
    router: { unregisterFrame() {} },
    storageService: { detach() {} },
    networkService: { unregisterFrame() {} },
    themeHost: {},
    contextRegistry: { unregister() {} },
    requestQueue: { dropContext() {} },
    getPanelHost: () => null,
    isFrontendFrame: () => false,
    evalInPage: async () => [],
    reloadInPage: async () => ({}),
    tabHost: {},
    notificationHost: {},
    saveService: {},
    optionsHost: {},
    getContentBridge: () => null,
    ...extra,
  });

test("every channel is installed on the attached WebContents, and only there", () => {
  const broker = makeBroker();
  broker.register();
  const frontend = fakeContents();
  const stranger = fakeContents();
  broker.attachContents(frontend);
  assert.ok(frontend.handlers.has(channels.RUNTIME_REGISTER));
  assert.ok(frontend.handlers.has(channels.THEME_REPORT));
  assert.ok(frontend.handlers.size > 20, `saw ${frontend.handlers.size} channels`);
  assert.equal(stranger.handlers.size, 0, "a WebContents nobody attached has no extension channel");
  broker.dispose();
});

test("detach removes the handlers; attaching twice installs once", () => {
  const broker = makeBroker();
  broker.register();
  const contents = fakeContents();
  const detach = broker.attachContents(contents);
  assert.equal(broker.attachContents(contents), detach, "the second attach is the same attachment");
  detach();
  assert.equal(contents.handlers.size, 0);
  detach();
  // Attach again after a detach: a fresh install, not a duplicate-registration throw.
  broker.attachContents(contents);
  assert.ok(contents.handlers.size > 0);
  broker.dispose();
  assert.equal(contents.handlers.size, 0, "dispose detaches every WebContents");
});

test("a destroyed WebContents is forgotten and never touched again", () => {
  const broker = makeBroker();
  broker.register();
  const contents = fakeContents();
  broker.attachContents(contents);
  contents.ipc.removeHandler = () => assert.fail("removeHandler on a destroyed WebContents");
  contents.destroy();
  broker.dispose();
  assert.deepEqual(broker.attachContents(contents)(), undefined, "a destroyed one is not attached");
});

test("wrapHandler decorates each handler before it is installed", () => {
  const seen = [];
  const broker = makeBroker({
    wrapHandler: (channel, handler) => {
      seen.push(channel);
      return channel === channels.RUNTIME_GET_MANIFEST ? () => "wrapped" : handler;
    },
  });
  broker.register();
  const contents = fakeContents();
  broker.attachContents(contents);
  assert.ok(seen.includes(channels.RUNTIME_REGISTER));
  assert.equal(contents.handlers.get(channels.RUNTIME_GET_MANIFEST)(), "wrapped");
  broker.dispose();
});
