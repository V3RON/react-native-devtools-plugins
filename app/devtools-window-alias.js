// Dev-only (metro.config.js). Metro polyfills run before React Native's setUpGlobals
// gives the app `global.window`, and the MobX DevTools hook installer that runs right
// after this one is written for a browser (`}(window)`). Same assignment RN makes later.
if (global.window === undefined) global.window = global;
