// What `InspectorFrontendHost.getHostConfig()` answers: the frontend's picture of the
// embedder (Root.Runtime.HostConfig, docs/api/INSPECTOR-FRONTEND-HOST.md).
//
// The frontend does `Object.assign(Runtime.hostConfig, answer)` once at startup, so every
// key here is a decision about a feature gate the frontend reads. This build of the
// frontend (@react-native/debugger-frontend) reads exactly the keys below; it has no
// `experiments` or `disableAutosave` key, so none is emitted — the config the frontend
// understands is the only config worth sending. Each default is the honest answer for
// THIS embedder, not a way to hide something that would work:
//
//   aidaAvailability / devToolsConsoleInsights / devToolsFreestyler /
//   devToolsAiAssistance{Network,File,Performance}Agent / devToolsAiGeneratedTimelineLabels
//       enabled:false — Chrome's AI features (AIDA) call a Google service with the
//       signed-in Chrome profile's credentials. This shell has no Google account, no
//       sync and no AIDA proxy (`doAidaConversation` answers "Not implemented"), so
//       offering "Understand this error" or an AI assistance panel would be a button
//       that can only fail. `disallowLogging:true` is the privacy-safe answer should a
//       deployment turn AIDA back on.
//   devToolsPrivacyUI: enabled:false — the Privacy and Security panel's cookie report
//       relies on Chrome's third-party-cookie browser state; there is none here.
//   thirdPartyCookieControls — all off, same reason.
//   devToolsVeLogging: enabled:false — Chrome's visual-element telemetry; nothing
//       collects it, so do not spend the cycles building it.
//   isOffTheRecord: false — not an incognito window; settings persist
//       (src/main/preferences.js).
//
// A deployment can change any of it with DEVTOOLS_HOST_CONFIG (a JSON object, merged
// one level deep over these defaults; src/main/config.js).
const DEFAULT_HOST_CONFIG = Object.freeze({
  aidaAvailability: {
    enabled: false,
    blockedByAge: false,
    blockedByGeo: false,
    blockedByEnterprisePolicy: false,
    disallowLogging: true,
  },
  devToolsConsoleInsights: { enabled: false },
  devToolsFreestyler: { enabled: false },
  devToolsAiAssistanceNetworkAgent: { enabled: false },
  devToolsAiAssistanceFileAgent: { enabled: false },
  devToolsAiAssistancePerformanceAgent: { enabled: false },
  devToolsAiGeneratedTimelineLabels: { enabled: false },
  devToolsPrivacyUI: { enabled: false },
  thirdPartyCookieControls: {
    thirdPartyCookieMetadataEnabled: false,
    thirdPartyCookieHeuristicsEnabled: false,
    managedBlockThirdPartyCookies: "Unset",
  },
  devToolsVeLogging: { enabled: false },
  isOffTheRecord: false,
});

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * The host config: defaults, with `override` merged over them one level deep (so
 * `{"aidaAvailability": {"enabled": true}}` keeps the other aida keys). Returns a fresh
 * object every call, so a caller cannot mutate the defaults.
 */
const buildHostConfig = (override = null) => {
  const config = {};
  for (const [key, value] of Object.entries(DEFAULT_HOST_CONFIG)) {
    config[key] = isPlainObject(value) ? { ...value } : value;
  }
  if (isPlainObject(override)) {
    for (const [key, value] of Object.entries(override)) {
      config[key] =
        isPlainObject(value) && isPlainObject(config[key]) ? { ...config[key], ...value } : value;
    }
  }
  return config;
};

module.exports = { DEFAULT_HOST_CONFIG, buildHostConfig };
