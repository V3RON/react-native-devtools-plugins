// HTTP byte ranges for the extension file server (RFC 9110 §14). Pure.
//
// One range per request. A multi-range request, a unit other than `bytes`, or a header
// that does not parse is IGNORED and the whole file is served, which the RFC allows ("a
// server MAY ignore the Range header field") and which is what a media pipeline copes
// with. A range that parses but starts past the end is unsatisfiable: 416.

/**
 * @param {string|null|undefined} header the request's `Range`
 * @param {number} size the file's length in bytes
 * @returns {{kind: "whole"} | {kind: "partial", start: number, end: number} | {kind: "unsatisfiable"}}
 *          `end` is inclusive
 */
const parseRange = (header, size) => {
  if (typeof header !== "string") {
    return { kind: "whole" };
  }
  const match = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) {
    return { kind: "whole" }; // multi-range, another unit, or not a range at all
  }
  const [, first, last] = match;
  if (first === "") {
    // `bytes=-n`: the last n bytes.
    const suffix = Number(last);
    if (suffix === 0 || size === 0) {
      return { kind: "unsatisfiable" };
    }
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (last !== "" && Number(last) < start) {
    return { kind: "whole" }; // `bytes=5-2` is invalid syntax, not an empty range
  }
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "partial", start, end };
};

module.exports = { parseRange };
