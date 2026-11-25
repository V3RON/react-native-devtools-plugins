// Learn more https://docs.expo.io/guides/customizing-metro
const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withRozenite } = require('@rozenite/metro');

const withDevtools = process.env.WITH_ROZENITE === 'true';

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

if (withDevtools) {
  // Dev-only: run these DevTools extensions' MAIN-world hooks as a polyfill, i.e. before
  // any module, in each extension's own scope (the same one the shell's content bridge
  // injects into when a debugger attaches). A content script injected on attach is
  // always too late for a library that looks for its hook once, at load time:
  //   - mobx calls `__MOBX_DEVTOOLS_GLOBAL_HOOK__.injectMobx(...)` when it loads;
  //   - Redux's configureStore reads `__REDUX_DEVTOOLS_EXTENSION_COMPOSE__` when the store
  //     is created;
  //   - relay-runtime registers each Environment with `__RELAY_DEVTOOLS_HOOK__` from its
  //     constructor. Relay's hook reaches the page through `<script src>` from its content
  //     script, not a MAIN-world entry, so its file is named here.
  // Apollo, TanStack Query and React Context DevTool find their client/hook whenever they
  // are injected, so they need nothing here. The extensions' files are read from
  // ../extensions (folders or .crx), never copied into this app.
  const { earlyMainWorldSource } = require('../src/electron/extensions/early-main-world');
  const { source, ran, problems } = earlyMainWorldSource({
    extensionsDir: path.resolve(__dirname, '../extensions'),
    extensions: [
      'mobx-devtools',
      'lmhkpmbekcpmknklioeibfkpmmfibljd', // Redux DevTools
      { id: 'ncedobpgnmkhcmnnkcimnobpfepidadl', files: ['build/injectedRelayDevToolsDetector.js'] }, // Relay
    ],
  });
  for (const problem of problems) console.warn(`[devtools] early hooks: ${problem}`);
  console.log(`[devtools] early hooks: ${ran.map((hook) => `${hook.id}/${hook.file}`).join(', ')}`);
  const earlyHooks = path.join(__dirname, '.devtools', 'early-hooks.js');
  fs.mkdirSync(path.dirname(earlyHooks), { recursive: true });
  fs.writeFileSync(earlyHooks, source);

  const polyfills = config.serializer.getPolyfills;
  config.serializer.getPolyfills = (ctx) => [...polyfills(ctx), earlyHooks];
}

module.exports = withRozenite(config, { enabled: withDevtools });
