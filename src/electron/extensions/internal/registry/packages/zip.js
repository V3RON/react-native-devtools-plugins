// A read-only ZIP reader for the archive inside a .crx (./crx-package.js). No
// dependencies: the central directory is parsed once, and an entry's bytes are read and
// inflated (`zlib`) only when someone asks for them.
//
// Deliberately narrow, and refusing rather than guessing:
//   - methods 0 (stored) and 8 (deflate) only; an encrypted entry is refused;
//   - no ZIP64 (an archive or entry over 4 GB is refused as a whole);
//   - a symlink entry (Unix mode in the external attributes) is refused, never followed;
//   - names are taken as the archive spells them; the package decides which are usable.
//
// Offsets in the central directory are relative to the start of the archive, which in a
// .crx is wherever its header ends (`base`).
const fs = require("fs");
const zlib = require("zlib");

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_COMMENT = 0xffff;

const readAt = (fd, position, length) => {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const read = fs.readSync(fd, buffer, done, length - done, position + done);
    if (read === 0) {
      throw new Error(`zip: unexpected end of file at ${position + done}`);
    }
    done += read;
  }
  return buffer;
};

/** The end-of-central-directory record, searched backwards over the comment. */
const findEnd = (fd, base, size) => {
  const span = Math.min(size - base, 22 + MAX_COMMENT);
  const tail = readAt(fd, size - span, span);
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      return {
        entries: tail.readUInt16LE(index + 10),
        directorySize: tail.readUInt32LE(index + 12),
        directoryOffset: tail.readUInt32LE(index + 16),
      };
    }
  }
  throw new Error("zip: no end-of-central-directory record");
};

/**
 * Index an archive.
 *
 * @param {number} fd an open file descriptor
 * @param {{base: number, size: number}} where the archive starts in the file, and the file's size
 * @returns {Map<string, {name, method, compressedSize, size, crc, localOffset, isDirectory, refused?}>}
 */
const readDirectory = (fd, { base, size }) => {
  const end = findEnd(fd, base, size);
  if (end.entries === 0xffff || end.directoryOffset === 0xffffffff || end.directorySize === 0xffffffff) {
    throw new Error("zip: ZIP64 archives are not supported");
  }
  const directory = readAt(fd, base + end.directoryOffset, end.directorySize);
  const entries = new Map();
  let at = 0;
  for (let count = 0; count < end.entries; count += 1) {
    if (directory.readUInt32LE(at) !== CENTRAL) {
      throw new Error(`zip: bad central directory entry ${count}`);
    }
    const madeBy = directory.readUInt16LE(at + 4);
    const flags = directory.readUInt16LE(at + 8);
    const method = directory.readUInt16LE(at + 10);
    const crc = directory.readUInt32LE(at + 16);
    const compressedSize = directory.readUInt32LE(at + 20);
    const uncompressedSize = directory.readUInt32LE(at + 24);
    const nameLength = directory.readUInt16LE(at + 28);
    const extraLength = directory.readUInt16LE(at + 30);
    const commentLength = directory.readUInt16LE(at + 32);
    const externalAttributes = directory.readUInt32LE(at + 38);
    const localOffset = directory.readUInt32LE(at + 42);
    const rawName = directory.subarray(at + 46, at + 46 + nameLength);
    // Bit 11: the name is UTF-8. Otherwise CP437, whose ASCII half is all a sane
    // extension uses; latin1 keeps every byte distinct rather than inventing characters.
    const name = rawName.toString(flags & 0x800 ? "utf8" : "latin1");
    at += 46 + nameLength + extraLength + commentLength;

    const unixMode = madeBy >> 8 === 3 ? externalAttributes >>> 16 : 0;
    let refused = null;
    if (flags & 0x1) refused = "encrypted";
    else if (method !== 0 && method !== 8) refused = `compression method ${method}`;
    else if ((unixMode & 0o170000) === 0o120000) refused = "a symlink";
    else if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      refused = "ZIP64";
    }
    entries.set(name, {
      name,
      method,
      compressedSize,
      size: uncompressedSize,
      crc,
      localOffset,
      isDirectory: name.endsWith("/"),
      refused,
    });
  }
  return entries;
};

/** Where an entry's data starts: after ITS local header, whose lengths can differ from the central one. */
const dataOffset = (fd, base, entry) => {
  if (entry.dataOffset === undefined) {
    const header = readAt(fd, base + entry.localOffset, 30);
    if (header.readUInt32LE(0) !== LOCAL) {
      throw new Error(`zip: bad local header for ${entry.name}`);
    }
    entry.dataOffset = base + entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  }
  return entry.dataOffset;
};

/** The entry's whole content, inflated and checked against its CRC. */
const readEntry = (fd, base, entry) => {
  const raw = readAt(fd, dataOffset(fd, base, entry), entry.compressedSize);
  const bytes = entry.method === 0 ? raw : zlib.inflateRawSync(raw);
  if (bytes.length !== entry.size || zlib.crc32(bytes) !== entry.crc) {
    throw new Error(`zip: ${entry.name} is corrupt (size or CRC mismatch)`);
  }
  return bytes;
};

module.exports = { readDirectory, readEntry, dataOffset, readAt };
