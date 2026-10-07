// just-bash's browser bundle imports node:zlib for gzip, gunzip, zcat and rg's gzip search. Hermes has no zlib and
// the app offers none of those commands, so Metro resolves the import here and any use fails with a clear message.
function unsupported(): never {
  throw new Error('gzip is not supported in this shell.');
}

export const constants = Object.freeze({ Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 });
export const gzipSync = unsupported;
export const gunzipSync = unsupported;
