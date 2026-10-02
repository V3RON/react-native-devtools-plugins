// chrome.alarms on FAKE timers (src/chrome-shim/alarms.js) — GitHub issue #4.
//
// Nothing here waits, and nothing here touches a real clock: `setTimer`/`clearTimer`
// are injected, so a "tick" is a call this file makes. That is also the point — the
// schedule rules (Chrome's argument validation, replace-on-recreate, `scheduledTime`
// semantics) are checked exactly, and only the wait is fake.
// Run: npm test
const test = require("node:test");
const assert = require("node:assert");

const { createAlarms, scheduleFor, MIN_DELAY_MS } = require("../src/chrome-shim/alarms");

/** A clock the test drives by hand. */
const fakeClock = (start = 1_000_000) => {
  let nowMs = start;
  const pending = [];
  let seq = 0;
  const setTimer = (ms, fn) => {
    const handle = ++seq;
    pending.push({ handle, at: nowMs + ms, fn });
    return handle;
  };
  return {
    now: () => nowMs,
    setTimer,
    clearTimer: (handle) => {
      const index = pending.findIndex((entry) => entry.handle === handle);
      if (index !== -1) {
        pending.splice(index, 1);
      }
    },
    armed: () => pending.map((entry) => ({ at: entry.at, ms: entry.at - nowMs })),
    /** Run everything pending NOW, wherever the clock happens to be — i.e. a tick
     *  that arrived late. Used to prove `scheduledTime` is not the tick's clock. */
    fireLate: async () => {
      for (const entry of [...pending].sort((a, b) => a.at - b.at)) {
        pending.splice(pending.indexOf(entry), 1);
        entry.fn();
        await Promise.resolve();
      }
    },
    /** Advance to `ms` and run everything scheduled at or before it, in order. */
    advance: async (ms) => {
      const target = nowMs + ms;
      for (;;) {
        const due = pending.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) {
          break;
        }
        nowMs = Math.max(nowMs, due.at);
        pending.splice(pending.indexOf(due), 1);
        due.fn();
        await Promise.resolve();
      }
      nowMs = target;
      await Promise.resolve();
    },
  };
};

const make = (clock = fakeClock()) => {
  const alarms = createAlarms({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const fired = [];
  alarms.onAlarm.addListener((alarm) => fired.push(alarm));
  return { alarms, clock, fired };
};

const MINUTE = 60_000;

test("delayInMinutes arms one timer, fires once, and forgets itself", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("cleanup", { delayInMinutes: 1 });
  assert.equal(clock.armed().length, 1);
  assert.equal(clock.armed()[0].at, clock.now() + MINUTE);

  await clock.advance(MINUTE);
  assert.deepEqual(fired, [{ name: "cleanup", scheduledTime: 1_060_000 }]);
  assert.equal(clock.armed().length, 0, "a one-shot alarm is gone after it fires");
  await clock.advance(MINUTE * 5);
  assert.equal(fired.length, 1);
});

test("periodInMinutes keeps firing, anchored on the schedule rather than the tick", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("pulse", { periodInMinutes: 1 });
  await clock.advance(MINUTE);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].periodInMinutes, 1);
  await clock.advance(MINUTE * 2);
  assert.deepEqual(
    fired.map((alarm) => alarm.scheduledTime),
    [1_060_000, 1_120_000, 1_180_000],
    "three occurrences at the period, not three occurrences spaced from the last tick"
  );
});

test("a late tick reports the SCHEDULED time, not Date.now of the tick", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("late", { delayInMinutes: 1 });
  // The context stalls four minutes past the alarm and only then runs the timer: the
  // listener still learns when the occurrence was scheduled FOR, which is the whole
  // reason Chrome's Alarm has that field instead of just firing.
  await clock.advance(MINUTE * 5);
  assert.equal(clock.armed().length, 0, "the timer is due");
  await clock.fireLate();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].scheduledTime, 1_060_000, "not 1_300_000, the tick's clock time");
});

test("`when` is an absolute time, and one in the past is allowed", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("future", { when: clock.now() + MINUTE * 3 });
  await clock.advance(MINUTE * 2);
  assert.equal(fired.length, 0);
  await clock.advance(MINUTE);
  assert.equal(fired.length, 1);

  alarms.create("past", { when: clock.now() - MINUTE * 10 });
  await clock.advance(0);
  assert.equal(fired.length, 2, "Chrome fires an already-due `when` rather than dropping it");
});

test("Chrome's argument rules are enforced, synchronously, in words Chrome uses", () => {
  const now = 0;
  assert.ok(
    scheduleFor({ delayInMinutes: 1, periodInMinutes: 2 }, now) instanceof TypeError,
    "delay + period together is Chrome's own TypeError"
  );
  assert.ok(scheduleFor({}, now) instanceof TypeError, "an empty alarmInfo");
  assert.ok(scheduleFor({ delayInMinutes: 0.0001 }, now) instanceof TypeError, "below Chrome's floor");
  assert.ok(scheduleFor({ periodInMinutes: 0.0001 }, now) instanceof TypeError, "period below its floor");
  assert.ok(MIN_DELAY_MS === 30_000, "the floor is Chrome's current 30 s");
  assert.deepEqual(scheduleFor({ delayInMinutes: 1 }, 1000), {
    when: 61_000,
    periodMs: null,
    periodInMinutes: null,
  });
  assert.deepEqual(scheduleFor({ periodInMinutes: 5 }, 0), {
    when: 300_000,
    periodMs: 300_000,
    periodInMinutes: 5,
  });
});

test("create with the same name replaces the schedule, and the old one cannot fire", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("job", { delayInMinutes: 1 });
  alarms.create("job", { delayInMinutes: 5 });
  assert.equal(clock.armed().length, 1, "one timer, not two");
  await clock.advance(MINUTE);
  assert.equal(fired.length, 0, "the replaced schedule is gone");
  await clock.advance(MINUTE * 4);
  assert.equal(fired.length, 1);
});

test("an anonymous alarm (no name) is its own single slot, like Chrome", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create({ delayInMinutes: 1 });
  alarms.create({ delayInMinutes: 2 });
  assert.equal(clock.armed().length, 1, "the second replaced the first, same nameless slot");
  await clock.advance(MINUTE * 2);
  assert.equal(fired.length, 1);
});

test("clear / getAll / get / clearAll report what is actually armed", async () => {
  const { alarms } = make();
  alarms.create("a", { delayInMinutes: 1 });
  alarms.create("b", { delayInMinutes: 2 });
  alarms.create({ delayInMinutes: 3 });

  const all = await alarms.getAll();
  assert.deepEqual(all.map((alarm) => alarm.name), ["", "a", "b"], "sorted, nameless first");
  assert.equal(all[2].scheduledTime > all[1].scheduledTime, true);
  assert.equal((await alarms.get("a")).name, "a");
  assert.strictEqual(await alarms.get("nope"), undefined);

  assert.strictEqual(await alarms.clear("a"), true);
  assert.strictEqual(await alarms.clear("a"), false);
  assert.equal((await alarms.getAll()).length, 2);
  assert.strictEqual(await alarms.clearAll(), 2);
  assert.deepEqual(await alarms.getAll(), []);
});

test("clearAll cancels the timers, so nothing fires afterwards", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("a", { delayInMinutes: 1 });
  alarms.create("b", { periodInMinutes: 1 });
  await alarms.clearAll();
  assert.equal(clock.armed().length, 0);
  await clock.advance(MINUTE * 10);
  assert.deepEqual(fired, []);
});

test("the context going away stops every alarm: nothing may fire after the worker is gone", async () => {
  const clock = fakeClock();
  const { alarms, fired } = make(clock);
  alarms.create("a", { periodInMinutes: 1 });
  alarms._cancelAll();
  await clock.advance(MINUTE * 5);
  assert.deepEqual(fired, [], "a periodic alarm outliving its context is the bug this guards");
});

test("promise vs callback style, and an Event that behaves like Chrome's", async () => {
  const { alarms } = make();
  alarms.create("a", { delayInMinutes: 1 });
  let viaCallback = null;
  const returned = alarms.getAll((list) => {
    viaCallback = list;
  });
  assert.strictEqual(returned, undefined, "callback style returns no promise");
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(viaCallback.length, 1);

  const fn = () => {};
  alarms.onAlarm.addListener(fn);
  alarms.onAlarm.addListener(fn);
  assert.equal(alarms.onAlarm.hasListener(fn), true);
  alarms.onAlarm.removeListener(fn);
  assert.equal(alarms.onAlarm.hasListener(fn), false);
});

test("a bad alarmInfo throws even in callback style — silence would schedule nothing", () => {
  const { alarms } = make();
  assert.throws(() => alarms.create("a", {}), TypeError);
  assert.throws(() => alarms.create("a", { delayInMinutes: 1, periodInMinutes: 1 }, () => {}), TypeError);
});

test("the host's clock scale shortens the wait without changing the reported schedule", async () => {
  const clock = fakeClock();
  const alarms = createAlarms({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    clockScale: () => 60, // 1 minute of alarm time per second of real time
  });
  const fired = [];
  alarms.onAlarm.addListener((alarm) => fired.push(alarm));
  alarms.create("fast", { delayInMinutes: 1 });
  assert.equal(clock.armed()[0].ms, 1000, "the timer is 60x shorter");
  await clock.advance(1000);
  assert.deepEqual(fired, [{ name: "fast", scheduledTime: 1_060_000 }], "the reported schedule is unchanged");
});

test("an unusable clockScale falls back to real time rather than firing instantly", async () => {
  const clock = fakeClock();
  for (const bad of [0, -1, NaN, undefined, null, "fast"]) {
    const alarms = createAlarms({
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      clockScale: () => bad,
    });
    alarms.create("x", { delayInMinutes: 1 });
    assert.equal(clock.armed()[0].ms, MINUTE, `scale ${String(bad)} behaves as 1`);
    alarms._cancelAll();
  }
});

test("chrome.alarms is gated on the declared alarms permission", async () => {
  const { createChromeNamespace } = require("../src/chrome-shim");
  const { createExtensionStorage, createMemoryBackend } = require("../src/chrome-shim/storage");
  const { createGrantGate } = require("../src/shared/permissions");
  const gate = createGrantGate(() => ({ alarms: false }));
  const chrome = createChromeNamespace({
    extensionId: "alarm.local",
    storage: createExtensionStorage({ createBackend: () => createMemoryBackend() }),
    networkBridge: { webRequest: {}, network: {} },
    permissions: gate,
    logger: { warn: () => {}, error: () => {}, log: () => {} },
  });
  gate.manifestLoaded();
  await assert.rejects(() => chrome.alarms.getAll(), /permission 'alarms' is not declared/);
  assert.ok(chrome.alarms.onAlarm.hasListener !== undefined, "the shape survives the denial");
});
