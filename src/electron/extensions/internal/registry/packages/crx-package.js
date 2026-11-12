// An extension package read straight from a .crx file (./crx.js, ./zip.js), never
// unpacked to disk.
//
// Built once per file version (the catalog caches it by path, mtime and size): the header
// is verified and the ZIP's central directory indexed, then every read goes to the file.
//
// Containment is by construction: an inner path is a key in the index, and a key either
// exists or it does not, so no name can reach outside the archive. What the index refuses:
//   - names that are not already normal (`/abs`, `a/../b`, `a//b`, backslashes, NUL):
//     an archive that spells a name two ways must not get to choose which one wins;
//   - symlink, encrypted, ZIP64 or unknown-method entries (./zip.js);
//   - `_metadata/`, which Chrome reserves (the Web Store's verified_contents.json), and the
//     host's own reserved inner paths.
//
// Ranges: a stored entry is a slice of the file, so it seeks for free. A deflated entry
// cannot be entered mid-stream: small ones (≤ CACHE_ENTRY_BYTES) are inflated once and
// kept, larger ones are inflated from the start on each request and the bytes before the
// range are dropped. Correct, and the cost of a late seek into a large deflated file.
const fs = require("fs");
const zlib = require("zlib");
const { Readable, Transform } = require("stream");
const { RESERVED_INNER_PATHS } = require("../../scheme/protocol");
const { innerPathOf } = require("./inner-path");
const { readCrx } = require("./crx");
const { readDirectory, readEntry, dataOffset } = require("./zip");

const CACHE_ENTRY_BYTES = 4 * 1024 * 1024;
const CACHE_TOTAL_BYTES = 16 * 1024 * 1024;
const METADATA_DIR = "_metadata";

const withFd = (file, use) => {
  const fd = fs.openSync(file, "r");
  try {
    return use(fd);
  } finally {
    fs.closeSync(fd);
  }
};

/** Pass through only bytes [start, end] of a stream (inclusive), then stop. */
const slice = (start, end) => {
  let position = 0;
  let finished = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      if (finished) {
        done(); // the range is complete; the rest of the inflated stream is dropped
        return;
      }
      const from = Math.max(0, start - position);
      const to = Math.min(chunk.length, end - position + 1);
      position += chunk.length;
      if (to > from) {
        this.push(chunk.subarray(from, to));
      }
      if (position > end) {
        finished = true;
        this.push(null);
      }
      done();
    },
  });
};

/**
 * @param {{file: string}} options an absolute path to a .crx
 * @returns {object} an ExtensionPackage, plus `problems`: names the index refused
 * @throws when the file is not a valid, verifying CRX3 with a readable archive
 */
const createCrxPackage = ({ file }) => {
  const stat = fs.statSync(file);
  const { id, base, entries } = withFd(file, (fd) => {
    const header = readCrx(fd, stat.size);
    return { ...header, entries: readDirectory(fd, { base: header.base, size: stat.size }) };
  });

  const files = new Map(); // inner path -> zip entry
  const refused = new Map(); // inner path -> reason
  const directories = new Set([""]);
  const problems = [];
  const addParents = (inner) => {
    const parts = inner.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  };
  for (const entry of entries.values()) {
    const raw = entry.isDirectory ? entry.name.slice(0, -1) : entry.name;
    const inner = innerPathOf(raw);
    if (inner === null || inner === "" || inner !== raw || raw.includes("\\")) {
      problems.push(`ignored archive entry ${JSON.stringify(entry.name)}: not a plain relative name`);
      continue;
    }
    addParents(inner);
    if (entry.isDirectory) {
      directories.add(inner);
    } else if (entry.refused) {
      refused.set(inner, `refused: the archive entry is ${entry.refused}`);
    } else {
      files.set(inner, entry);
    }
  }

  const cache = new Map(); // inner path -> Buffer, least recently used first
  let cachedBytes = 0;
  const remember = (inner, bytes) => {
    if (bytes.length > CACHE_ENTRY_BYTES) {
      return;
    }
    cache.set(inner, bytes);
    cachedBytes += bytes.length;
    for (const [key, value] of cache) {
      if (cachedBytes <= CACHE_TOTAL_BYTES) break;
      cache.delete(key);
      cachedBytes -= value.length;
    }
  };

  const resolve = (innerPath) => {
    const inner = innerPathOf(innerPath);
    if (inner === null) {
      return { inner: null, reason: "refused: it resolves outside the extension" };
    }
    if (RESERVED_INNER_PATHS.has(inner)) {
      return { inner: null, reason: "refused: a reserved path" };
    }
    if (inner === METADATA_DIR || inner.startsWith(`${METADATA_DIR}/`)) {
      return { inner: null, reason: "refused: _metadata is reserved by Chrome" };
    }
    if (refused.has(inner)) {
      return { inner: null, reason: refused.get(inner) };
    }
    return { inner };
  };

  const entry = (innerPath) => {
    const { inner, reason } = resolve(innerPath);
    if (inner === null) {
      return { kind: "refused", reason };
    }
    if (files.has(inner)) {
      return { kind: "file", size: files.get(inner).size, mtimeMs: stat.mtimeMs };
    }
    return directories.has(inner) ? { kind: "directory", size: 0, mtimeMs: stat.mtimeMs } : { kind: "missing" };
  };

  const read = (innerPath) => {
    const { inner } = resolve(innerPath);
    if (inner === null || !files.has(inner)) {
      return null;
    }
    if (cache.has(inner)) {
      const bytes = cache.get(inner);
      cache.delete(inner); // refresh its place in the LRU order
      cache.set(inner, bytes);
      return bytes;
    }
    let bytes;
    try {
      bytes = withFd(file, (fd) => readEntry(fd, base, files.get(inner)));
    } catch {
      return null; // corrupt or vanished: the same "no such readable file" as a folder's
    }
    remember(inner, bytes);
    return bytes;
  };

  const open = (innerPath, { start = 0, end } = {}) => {
    const { inner } = resolve(innerPath);
    if (inner === null || !files.has(inner)) {
      return null;
    }
    const zipEntry = files.get(inner);
    const size = zipEntry.size;
    const last = end === undefined ? size - 1 : Math.min(end, size - 1);
    if (size === 0 || start > last) {
      return { size, stream: Readable.from([]) };
    }
    if (zipEntry.method === 0) {
      const offset = withFd(file, (fd) => dataOffset(fd, base, zipEntry));
      return { size, stream: fs.createReadStream(file, { start: offset + start, end: offset + last }) };
    }
    if (size <= CACHE_ENTRY_BYTES || cache.has(inner)) {
      const bytes = read(inner);
      return bytes === null ? null : { size, stream: Readable.from([bytes.subarray(start, last + 1)]) };
    }
    const offset = withFd(file, (fd) => dataOffset(fd, base, zipEntry));
    const compressed = fs.createReadStream(file, { start: offset, end: offset + zipEntry.compressedSize - 1 });
    const inflate = zlib.createInflateRaw();
    const range = slice(start, last);
    range.on("close", () => {
      compressed.destroy();
      inflate.destroy();
    });
    compressed.on("error", (error) => range.destroy(error));
    inflate.on("error", (error) => range.destroy(error));
    return { size, stream: compressed.pipe(inflate).pipe(range) };
  };

  return {
    id,
    source: "crx",
    file,
    cacheKey: `crx:${file}:${stat.mtimeMs}:${stat.size}`,
    problems,
    entry,
    list: (innerDir) => {
      const { inner } = resolve(innerDir);
      if (inner === null || !directories.has(inner)) {
        return null;
      }
      const prefix = inner ? `${inner}/` : "";
      const names = new Set();
      for (const name of [...files.keys(), ...refused.keys(), ...directories]) {
        if (name && name.startsWith(prefix) && name !== inner) {
          names.add(name.slice(prefix.length).split("/")[0]);
        }
      }
      return [...names].map((name) => {
        const { kind, reason } = entry(prefix + name);
        return { name, kind, reason };
      });
    },
    read,
    readText: (innerPath) => {
      const bytes = read(innerPath);
      return bytes === null ? null : bytes.toString("utf8").replace(/^﻿/, "");
    },
    open,
    describe: (innerPath) => `${file}!/${innerPathOf(innerPath) || innerPath}`,
  };
};

module.exports = { createCrxPackage, CACHE_ENTRY_BYTES };
