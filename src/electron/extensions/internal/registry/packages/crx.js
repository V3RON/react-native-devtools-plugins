// The CRX3 container (Chromium components/crx_file): a header in front of a ZIP.
//
//   "Cr24"  uint32le 3  uint32le headerSize  CrxFileHeader (protobuf)  ZIP archive
//
//   CrxFileHeader { repeated AsymmetricKeyProof sha256_with_rsa = 2;
//                   repeated AsymmetricKeyProof sha256_with_ecdsa = 3;
//                   bytes signed_header_data = 10000; }      // SignedData { bytes crx_id = 1; }
//   AsymmetricKeyProof { bytes public_key = 1; bytes signature = 2; }   // SPKI DER, signature
//
// Every proof signs  "CRX3 SignedData\x00" + uint32le(len(signed_header_data)) +
// signed_header_data + the archive, and the extension id is crx_id: the first 16 bytes of
// SHA-256 over the DEVELOPER's public key, written as letters a–p. Verified the way
// Chromium's crx_verifier does it: every proof must verify, and one of the keys must hash
// to crx_id. That proves the file is intact and that whoever holds that key made it; it
// does not prove where it came from (that would be the Web Store's own key, not checked).
//
// CRX2 (version 2, RSA-SHA1, no signed id) is refused: Chrome stopped accepting it in 2019.
const crypto = require("crypto");
const { readAt } = require("./zip");

const MAGIC = "Cr24";
const SIGNED_DATA_PREFIX = Buffer.from("CRX3 SignedData\x00", "binary");
const MAX_HEADER = 1024 * 1024;

// ── a minimal protobuf reader: varints and length-delimited fields are all CRX uses ──
const readVarint = (buffer, at) => {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (at >= buffer.length || shift > 49) {
      throw new Error("crx: malformed header (varint)");
    }
    const byte = buffer[at];
    at += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      return { value, at };
    }
  }
};

/** @returns {Array<{field: number, bytes?: Buffer}>} the message's fields, in order */
const protoFields = (buffer) => {
  const fields = [];
  let at = 0;
  while (at < buffer.length) {
    const key = readVarint(buffer, at);
    at = key.at;
    const field = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === 0) {
      at = readVarint(buffer, at).at;
      fields.push({ field });
    } else if (wire === 2) {
      const length = readVarint(buffer, at);
      at = length.at + length.value;
      if (at > buffer.length) {
        throw new Error("crx: malformed header (length)");
      }
      fields.push({ field, bytes: buffer.subarray(length.at, at) });
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4;
      fields.push({ field });
    } else {
      throw new Error(`crx: malformed header (wire type ${wire})`);
    }
  }
  return fields;
};

const bytesOf = (buffer, field) => {
  const found = protoFields(buffer).find((entry) => entry.field === field && entry.bytes);
  return found ? found.bytes : null;
};

/** Chrome's id: 16 bytes as hex, each hex digit 0–f written as a–p. Pure. */
const idFromBytes = (bytes) =>
  [...Buffer.from(bytes).subarray(0, 16).toString("hex")]
    .map((digit) => String.fromCharCode(97 + parseInt(digit, 16)))
    .join("");

/** The id a public key gives an extension (SPKI DER). Pure. */
const idFromPublicKey = (spki) => idFromBytes(crypto.createHash("sha256").update(spki).digest());

/** Feed `[start, end)` of the file to `update` in chunks. */
const feed = (fd, start, end, update) => {
  const chunk = 1024 * 1024;
  for (let at = start; at < end; at += chunk) {
    update(readAt(fd, at, Math.min(chunk, end - at)));
  }
};

/**
 * Read and verify a CRX header.
 *
 * @param {number} fd an open file descriptor
 * @param {number} size the file's size
 * @returns {{id: string, base: number, publicKey: Buffer}} the extension id, where the
 *          ZIP starts, and the developer key
 * @throws when the file is not a CRX3, is malformed, or does not verify
 */
const readCrx = (fd, size) => {
  if (size < 12) {
    throw new Error("crx: too short to be a CRX file");
  }
  const preamble = readAt(fd, 0, 12);
  if (preamble.toString("binary", 0, 4) !== MAGIC) {
    throw new Error('crx: not a CRX file (no "Cr24" magic)');
  }
  const version = preamble.readUInt32LE(4);
  if (version === 2) {
    throw new Error("crx: CRX2 is not supported (Chrome refuses it too); repack it as CRX3");
  }
  if (version !== 3) {
    throw new Error(`crx: unknown CRX version ${version}`);
  }
  const headerSize = preamble.readUInt32LE(8);
  if (headerSize > MAX_HEADER || 12 + headerSize > size) {
    throw new Error("crx: header size out of range");
  }
  const header = readAt(fd, 12, headerSize);
  const base = 12 + headerSize;

  const signedHeaderData = bytesOf(header, 10000);
  const crxId = signedHeaderData ? bytesOf(signedHeaderData, 1) : null;
  if (!crxId || crxId.length !== 16) {
    throw new Error("crx: the header carries no signed crx_id");
  }
  const proofs = [];
  for (const { field, bytes } of protoFields(header)) {
    if ((field === 2 || field === 3) && bytes) {
      proofs.push({
        algorithm: field === 2 ? "rsa" : "ecdsa",
        publicKey: bytesOf(bytes, 1),
        signature: bytesOf(bytes, 2),
      });
    }
  }
  if (proofs.length === 0) {
    throw new Error("crx: the header carries no signature");
  }

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length);
  let developerKey = null;
  for (const proof of proofs) {
    if (!proof.publicKey || !proof.signature) {
      throw new Error("crx: a key proof is incomplete");
    }
    const verifier = crypto.createVerify("sha256");
    verifier.update(SIGNED_DATA_PREFIX);
    verifier.update(length);
    verifier.update(signedHeaderData);
    feed(fd, base, size, (chunk) => verifier.update(chunk));
    let key;
    try {
      key = crypto.createPublicKey({ key: proof.publicKey, format: "der", type: "spki" });
    } catch (error) {
      throw new Error(`crx: unusable public key (${error.message})`);
    }
    const ok = verifier.verify(proof.algorithm === "ecdsa" ? { key, dsaEncoding: "der" } : key, proof.signature);
    if (!ok) {
      throw new Error("crx: a signature does not verify (the file was changed after signing)");
    }
    if (idFromPublicKey(proof.publicKey) === idFromBytes(crxId)) {
      developerKey = proof.publicKey;
    }
  }
  if (!developerKey) {
    throw new Error("crx: no signing key matches the crx_id");
  }
  return { id: idFromBytes(crxId), base, publicKey: developerKey };
};

module.exports = { readCrx, idFromBytes, idFromPublicKey, protoFields, SIGNED_DATA_PREFIX };
