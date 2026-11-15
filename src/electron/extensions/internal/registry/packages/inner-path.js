// The inner-path rule every package shares, for packages that are not a folder on disk
// (a folder's own rule is realpath containment, ./directory-package.js).
//
// An inner path is untrusted: it comes from a URL or a manifest. It is normalized the way
// `path.resolve` would inside a root — a leading `/` is the extension's root (Chrome's
// rule), `.` segments drop, `..` pops — and refused when it climbs above the root or
// carries a NUL. Pure.

/** @returns {string|null} the normalized inner path ("" is the root), or null when refused */
const innerPathOf = (raw) => {
  const text = String(raw === undefined || raw === null ? "" : raw);
  if (text.includes("\0")) {
    return null;
  }
  const out = [];
  for (const segment of text.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length === 0) {
        return null;
      }
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
};

module.exports = { innerPathOf };
