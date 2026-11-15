// Builds real CRX3 files for tests: a ZIP (stored or deflated entries), a CrxFileHeader
// protobuf with a signed crx_id, and a SHA-256 signature by a freshly generated key — the
// format Chromium's crx_creator writes (components/crx_file). Independent of the reader
// under test except for the published format itself.
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const varint = (value) => {
  const bytes = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};
const field = (number, bytes) => Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);

/**
 * @param {Array<{name: string, data?: string|Buffer, method?: 0|8, symlink?: boolean}>} entries
 *        a name ending in "/" is a directory entry
 */
const buildZip = (entries) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data === undefined ? "" : entry.data);
    const method = entry.method === undefined ? 8 : entry.method;
    const stored = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode is meaningful
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.symlink ? 0o120777 : entry.name.endsWith("/") ? 0o040755 : 0o100644;
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/** A fresh signing key and the id Chrome derives from it. */
const makeKey = (algorithm = "rsa") => {
  const { privateKey, publicKey } =
    algorithm === "ecdsa"
      ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
      : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const digest = crypto.createHash("sha256").update(spki).digest().subarray(0, 16);
  const id = [...digest.toString("hex")].map((d) => String.fromCharCode(97 + parseInt(d, 16))).join("");
  return { algorithm, privateKey, spki, crxId: digest, id };
};

/**
 * @param {object} options
 * @param {Array} options.entries for buildZip
 * @param {object} [options.key] from makeKey (a new RSA key by default)
 * @param {Buffer} [options.archive] a prebuilt archive instead of `entries`
 * @param {(bytes: Buffer) => Buffer} [options.tamper] changes the finished file
 * @returns {{bytes: Buffer, id: string, key: object}}
 */
const buildCrx = ({ entries, key = makeKey(), archive = buildZip(entries), tamper = (b) => b }) => {
  const signedHeaderData = field(1, key.crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  const message = Buffer.concat([Buffer.from("CRX3 SignedData\x00", "binary"), length, signedHeaderData, archive]);
  const signature =
    key.algorithm === "ecdsa"
      ? crypto.sign("sha256", message, { key: key.privateKey, dsaEncoding: "der" })
      : crypto.sign("sha256", message, key.privateKey);
  const proof = Buffer.concat([field(1, key.spki), field(2, signature)]);
  const header = Buffer.concat([field(key.algorithm === "ecdsa" ? 3 : 2, proof), field(10000, signedHeaderData)]);
  const preamble = Buffer.alloc(12);
  preamble.write("Cr24", 0, "binary");
  preamble.writeUInt32LE(3, 4);
  preamble.writeUInt32LE(header.length, 8);
  return { bytes: tamper(Buffer.concat([preamble, header, archive])), id: key.id, key };
};

module.exports = { buildZip, buildCrx, makeKey };
