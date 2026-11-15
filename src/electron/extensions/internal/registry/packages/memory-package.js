// An extension package held in memory: `{"manifest.json": "…", "panel/index.html": "…"}`.
// For tests, and the reference for what every package must answer (./index.js).
const { Readable } = require("stream");
const { RESERVED_INNER_PATHS } = require("../../scheme/protocol");
const { innerPathOf } = require("./inner-path");

/**
 * @param {{id: string, files: Object<string, string|Buffer>, mtimeMs?: number}} options
 * @returns {object} an ExtensionPackage
 */
const createMemoryPackage = ({ id, files = {}, mtimeMs = 0 }) => {
  const contents = new Map();
  const directories = new Set([""]);
  for (const [name, value] of Object.entries(files)) {
    const inner = innerPathOf(name);
    if (!inner) {
      throw new Error(`memory package ${id}: unusable file name ${JSON.stringify(name)}`);
    }
    contents.set(inner, Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8"));
    const parts = inner.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }

  const resolve = (innerPath) => {
    const inner = innerPathOf(innerPath);
    return inner === null || RESERVED_INNER_PATHS.has(inner) ? null : inner;
  };

  const entry = (innerPath) => {
    const inner = resolve(innerPath);
    if (inner === null) {
      return { kind: "refused", reason: "refused: it resolves outside the extension folder" };
    }
    if (contents.has(inner)) {
      return { kind: "file", size: contents.get(inner).length, mtimeMs };
    }
    return directories.has(inner) ? { kind: "directory", size: 0, mtimeMs } : { kind: "missing" };
  };

  const read = (innerPath) => {
    const inner = resolve(innerPath);
    return inner !== null && contents.has(inner) ? contents.get(inner) : null;
  };

  return {
    id,
    source: "memory",
    cacheKey: `memory:${id}:${mtimeMs}`,
    entry,
    list: (innerDir) => {
      const inner = resolve(innerDir);
      if (inner === null || !directories.has(inner)) {
        return null;
      }
      const prefix = inner ? `${inner}/` : "";
      const names = new Set();
      for (const name of [...contents.keys(), ...directories]) {
        if (name && name.startsWith(prefix) && name !== inner) {
          names.add(name.slice(prefix.length).split("/")[0]);
        }
      }
      return [...names].map((name) => ({ name, kind: entry(prefix + name).kind }));
    },
    read,
    readText: (innerPath) => {
      const bytes = read(innerPath);
      return bytes === null ? null : bytes.toString("utf8").replace(/^﻿/, "");
    },
    open: (innerPath, { start = 0, end } = {}) => {
      const bytes = read(innerPath);
      if (bytes === null) {
        return null;
      }
      const last = end === undefined ? bytes.length - 1 : Math.min(end, bytes.length - 1);
      return { size: bytes.length, stream: Readable.from(start > last ? [] : [bytes.subarray(start, last + 1)]) };
    },
    describe: (innerPath) => `memory:${id}/${innerPathOf(innerPath) || innerPath}`,
  };
};

module.exports = { createMemoryPackage };
