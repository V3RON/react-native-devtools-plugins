// Chrome's `FilenameConflictAction`, as the two layers of the download channel share it
// (src/shared/downloads.js).
//
// `downloads-shim.test.js` pins what the extension SEES and `tier2-worker-electron.test.js`
// pins what a real process WRITES. This file pins the vocabulary itself, which is the thing
// both of those would otherwise be free to drift: the enum is a fact about Chrome, not a
// choice of ours, and the bug this whole area had (GitHub issue #27) was exactly a codebase
// that had written its own value — `"unique"` — into a check that was supposed to be
// Chrome's, comment and docs agreeing with the code, so two review rounds had to be
// overruled by the reference before it was corrected. A test that names Chrome's three
// values out loud is the cheap insurance against doing that again.
//
// The enum was read off developer.chrome.com (`downloads#type-FilenameConflictAction`) on
// 2026-10-14.
const test = require("node:test");
const assert = require("node:assert");

const {
  CHROME_CONFLICT_ACTIONS,
  PERFORMED_CONFLICT_ACTIONS,
  conflictActionForRequest,
} = require("../src/shared/downloads");

test("Chrome's enum is exactly uniquify, overwrite and prompt", () => {
  assert.deepEqual([...CHROME_CONFLICT_ACTIONS].sort(), ["overwrite", "prompt", "uniquify"]);
  assert.equal(
    CHROME_CONFLICT_ACTIONS.has("unique"),
    false,
    "`unique` is not a Chrome value — that single-letter difference was issue #27"
  );
});

test("the shell performs two of the three, and only those are forwarded", () => {
  assert.deepEqual(
    [...PERFORMED_CONFLICT_ACTIONS].sort(),
    ["overwrite", "uniquify"],
    "`prompt` needs a conflict dialog this host does not have"
  );
  for (const value of PERFORMED_CONFLICT_ACTIONS) {
    assert.equal(CHROME_CONFLICT_ACTIONS.has(value), true, "everything performed is a Chrome value");
  }
});

test("the field that goes to the save service is the value or `undefined`, never a guess", () => {
  assert.equal(conflictActionForRequest("uniquify"), "uniquify");
  assert.equal(conflictActionForRequest("overwrite"), "overwrite");
  // `undefined` is what the save service reads as "my own default", which is `uniquify` —
  // the outcome the shim's report promises for every value it turns down.
  for (const value of [undefined, "prompt", "unique", "UNIQUE", "", null, true, 0, "overwrite "]) {
    assert.equal(
      conflictActionForRequest(value),
      undefined,
      `${JSON.stringify(value)} decides nothing about the write`
    );
  }
});
