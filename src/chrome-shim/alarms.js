// `chrome.alarms` — real timers inside one extension context
// (docs/features/SMALL-SHIMS.md, GitHub issue #4).
//
// Chrome's model: the service worker registers alarms, Chrome persists them, and
// wakes the worker when one fires. This host's background context is always-on
// (docs/features/BACKGROUND-WORKER.md), so the second half of that is unnecessary
// and the first half is a plain timer. The divergence is recorded in
// docs/LIMITATIONS.md: alarms are tied to a live worker, so an alarm dies with the
// context instead of surviving to wake it. Nothing is persisted, because claiming
// persistence without a store would be a fabrication.
//
// Chrome's own semantics that ARE implemented here, because extensions depend on
// them:
//   - `create(name, alarmInfo)` — `when` (epoch ms), `delayInMinutes`,
//     `periodInMinutes`; `delayInMinutes` and `periodInMinutes` together are a
//     TypeError in Chrome, and `periodInMinutes` below its floor is one too;
//   - a re-`create` with the same name replaces the alarm, including `onAlarm`
//     firing for the NEW schedule only;
//   - `clear`/`clearAll` return the honest count of what was actually removed;
//   - `onAlarm` fires with `{name, scheduledTime, periodInMinutes?}` and
//     `scheduledTime` is the time the alarm was scheduled for, not Date.now() of
//     the tick (a coalesced/delayed tick must not be reported as on time).
//
// `setTimer`/`clearTimer` are injected: a test drives this on fake timers, and the
// frame decides which realm's timers to use (src/preload/extension-frame.js).
// Nothing here knows about Electron or IPC — the layering rule in
// docs/ARCHITECTURE.md.
const { createEvent } = require("./event");
const { promiseOrCallback } = require("./async-style");

// Chrome's own floors, from the alarms source: alarms shorter than these are
// rejected. Chrome's numbers have moved over versions (1 min -> 30 s); these are
// the current ones, and they are the ones a real extension's constants match.
const MIN_DELAY_MS = 30 * 1000;
const MIN_PERIOD_MS = 30 * 1000;

const asFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * alarmInfo -> the schedule, or an Error describing why it is invalid. Pure, so
 * the argument rules are unit-tested without timers.
 */
const scheduleFor = (alarmInfo, now) => {
  const info = alarmInfo || {};
  const when = asFiniteNumber(info.when);
  const delay = asFiniteNumber(info.delayInMinutes);
  const period = asFiniteNumber(info.periodInMinutes);

  if (delay !== null && period !== null && info.when === undefined) {
    return new TypeError(
      "chrome.alarms.create: delayInMinutes and periodInMinutes may not both be set."
    );
  }
  if (when === null && delay === null && period === null) {
    return new TypeError(
      "chrome.alarms.create: one of when, delayInMinutes or periodInMinutes is required."
    );
  }
  let firstFire;
  if (when !== null) {
    firstFire = when;
  } else if (delay !== null) {
    firstFire = now + delay * 60000;
  } else {
    // periodInMinutes alone: Chrome fires the first occurrence one period out.
    firstFire = now + period * 60000;
  }
  const delayMs = firstFire - now;
  if (delayMs < MIN_DELAY_MS && delay !== null) {
    // Chrome's rejection applies to an explicit delay below the floor; an explicit
    // `when` in the past fires immediately, which it also allows.
    return new TypeError(
      `chrome.alarms.create: delayInMinutes must be at least ${MIN_DELAY_MS / 60000}.`
    );
  }
  if (period !== null && period * 60000 < MIN_PERIOD_MS && delay === null) {
    return new TypeError(
      `chrome.alarms.create: periodInMinutes must be at least ${MIN_PERIOD_MS / 60000}.`
    );
  }
  return {
    when: firstFire,
    periodMs: period === null ? null : Math.max(period * 60000, MIN_PERIOD_MS),
    periodInMinutes: period,
  };
};

/**
 * @param {object} deps
 * @param {() => number} [deps.now] epoch ms
 * @param {(ms: number, fn: () => void) => any} deps.setTimer
 * @param {(handle: any) => void} deps.clearTimer
 */
const createAlarms = ({
  now = () => Date.now(),
  setTimer = (ms, fn) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
} = {}) => {
  const alarms = new Map(); // name -> {name, when, periodMs, periodInMinutes, handle}
  const onAlarm = createEvent();

  const cancel = (alarm) => {
    if (alarm.handle !== undefined) {
      clearTimer(alarm.handle);
      alarm.handle = undefined;
    }
  };

  /** Arm the next occurrence of `alarm`, honouring its own period. */
  const arm = (alarm) => {
    const delay = Math.max(0, alarm.when - now());
    alarm.handle = setTimer(delay, () => {
      const firedAt = alarm.when;
      onAlarm._fire({
        name: alarm.name,
        // Chrome: the time this occurrence was SCHEDULED for, so a worker that
        // woke late can still tell it was late.
        scheduledTime: firedAt,
        periodInMinutes: alarm.periodInMinutes === null ? undefined : alarm.periodInMinutes,
      });
      if (alarm.periodMs === null) {
        alarms.delete(alarm.name);
        return;
      }
      // Next occurrence anchored on the scheduled time, not on the tick: a late
      // tick must not push the whole schedule back.
      alarm.when = firedAt + alarm.periodMs;
      while (alarm.when <= now()) {
        alarm.when += alarm.periodMs;
      }
      arm(alarm);
    });
  };

  const create = (...args) => {
    const name = typeof args[0] === "string" ? args[0] : null;
    const alarmInfo = typeof args[0] === "object" && args[0] ? args[0] : args[1];
    const key = name === null ? "" : name;
    const schedule = scheduleFor(alarmInfo, now());
    if (schedule instanceof Error) {
      // Chrome throws synchronously for a bad alarmInfo.
      throw schedule;
    }
    const existing = alarms.get(key);
    if (existing) {
      cancel(existing);
    }
    const alarm = { name: key, ...schedule, handle: undefined };
    alarms.set(key, alarm);
    arm(alarm);
  };

  const clearAlarm = (name) => {
    const key = typeof name === "string" ? name : "";
    const alarm = alarms.get(key);
    if (!alarm) {
      return false;
    }
    cancel(alarm);
    alarms.delete(key);
    return true;
  };

  const clearAllAlarm = () => {
    const count = alarms.size;
    for (const alarm of alarms.values()) {
      cancel(alarm);
    }
    alarms.clear();
    return count;
  };

  const getAlarm = (name) => {
    const key = typeof name === "string" ? name : "";
    const alarm = alarms.get(key);
    return alarm === undefined ? undefined : describe(alarm);
  };

  const describe = (alarm) => ({
    name: alarm.name,
    scheduledTime: alarm.when,
    ...(alarm.periodInMinutes === null ? {} : { periodInMinutes: alarm.periodInMinutes }),
  });

  // Chrome's shape: every method answers promise-style with no callback, and
  // callback-style with no promise (docs/features/RUNTIME-MESSAGING.md contract).
  return {
    onAlarm,
    create: (nameOrInfo, alarmInfo, callback) =>
      // `create` throws synchronously for a bad alarmInfo, callback style or not:
      // that is Chrome's behavior, and a callback caller that never sees the
      // mistake would schedule nothing in silence.
      promiseOrCallback(() => create(nameOrInfo, alarmInfo), callback),
    clear: (nameOrCallback, callback) =>
      promiseOrCallback(
        () => clearAlarm(typeof nameOrCallback === "function" ? "" : nameOrCallback),
        typeof nameOrCallback === "function" ? nameOrCallback : callback
      ),
    get: (nameOrCallback, callback) =>
      promiseOrCallback(
        () => {
          const alarm = getAlarm(typeof nameOrCallback === "string" ? nameOrCallback : "");
          return alarm === undefined ? undefined : describe(alarm);
        },
        typeof nameOrCallback === "function" ? nameOrCallback : callback
      ),
    getAll: (callback) =>
      promiseOrCallback(
        () =>
          [...alarms.keys()]
            .sort()
            .map((key) => describe(alarms.get(key))),
        callback
      ),
    clearAll: (callback) => promiseOrCallback(() => clearAllAlarm(), callback),
    /** The context is going away: nothing may fire afterwards. */
    cancelAll: clearAllAlarm,
    /** How many alarms are armed — for the caller that has to report honestly. */
    size: () => alarms.size,
  };
};

module.exports = { MIN_DELAY_MS, MIN_PERIOD_MS, createAlarms, scheduleFor };
