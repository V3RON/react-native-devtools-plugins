// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withRozenite } = require('@rozenite/metro');

const withDevtools = process.env.WITH_ROZENITE === 'true';

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

if (withDevtools) {
  // Dev-only: run the MobX DevTools extension's own, unmodified hook installer as a
  // polyfill, i.e. before any module, so mobx's load-time
  // `__MOBX_DEVTOOLS_GLOBAL_HOOK__.injectMobx(...)` finds it. A content script
  // injected when the debugger attaches is always too late for that call.
  const mobxHook = path.resolve(__dirname, '../extensions/mobx-devtools/injectGlobalHook.js');
  const polyfills = config.serializer.getPolyfills;
  config.watchFolders = [...(config.watchFolders || []), path.dirname(mobxHook)];
  config.serializer.getPolyfills = (ctx) => [...polyfills(ctx), require.resolve('./devtools-window-alias'), mobxHook];
}

module.exports = withRozenite(config, { enabled: withDevtools });
