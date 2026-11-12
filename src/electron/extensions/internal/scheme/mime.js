// The Content-Type of a file an extension package serves, from its extension.
//
// The file server used to let Chromium pick the type through `net.fetch(file://)`. A
// package that is not a folder (a .crx) has no file to fetch, so the type is decided here,
// for every package alike. What matters most: a module script or a module worker with a
// non-JavaScript type is a hard load failure, and WebAssembly streaming compilation
// requires `application/wasm`. Text types carry `charset=utf-8`, which is what Chrome's
// own extension protocol does for `text/*`. A name with no known extension gets NO type,
// so Chromium sniffs it, as its file:// loader did before (an extension can ship a page
// named plain `html`, and the panel tests do). Pure.

const TYPES = {
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  xml: "text/xml",
  wasm: "application/wasm",
  svg: "image/svg+xml",
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
};

const TEXT = /^text\/|^application\/(json|manifest\+json|xhtml\+xml)$|^image\/svg\+xml$/;

/** `panel/index.html` → `text/html; charset=utf-8`; unknown → null (let Chromium sniff). */
const contentTypeFor = (innerPath) => {
  const name = String(innerPath || "").split("/").pop();
  const dot = name.lastIndexOf(".");
  const type = dot > 0 ? TYPES[name.slice(dot + 1).toLowerCase()] : undefined;
  if (!type) {
    return null;
  }
  return TEXT.test(type) ? `${type}; charset=utf-8` : type;
};

module.exports = { contentTypeFor, TYPES };
