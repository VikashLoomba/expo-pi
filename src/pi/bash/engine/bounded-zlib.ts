import { Gunzip, Gzip, type GzipOptions } from 'fflate/browser';

import { crc32, updateCrc32 } from './crc32';
import { MAX_CODEC_BYTES } from './limits';

export const constants = Object.freeze({
  Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1,
});

interface CodecOptions { maxOutputLength?: number; level?: number }
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_MEMBERS = 128;
// A deflate length/distance pair expands to at most 258 bytes. Small input
// chunks bound transient inflater output before its callback can enforce the
// total limit. This deliberately avoids trusting gzip's attacker-owned ISIZE.
const INFLATE_CHUNK_BYTES = 256;

function outputLimit(input: Uint8Array, options: CodecOptions): number {
  if (input.length > MAX_CODEC_BYTES) throw new RangeError('gzip: compressed/input size exceeds 4 MiB limit');
  const limit = options.maxOutputLength ?? MAX_CODEC_BYTES;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('gzip: invalid output limit');
  return Math.min(limit, MAX_CODEC_BYTES);
}

function collector(maxBytes: number) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  return {
    add(bytes: Uint8Array) {
      if (bytes.length > maxBytes - size) throw new RangeError(`gzip: output exceeds limit (${maxBytes} bytes)`);
      if (bytes.length) chunks.push(bytes);
      size += bytes.length;
    },
    finish() {
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
      return result;
    },
  };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** Validate metadata separately: fflate intentionally does not check gzip CRCs. */
function validateHeader(bytes: Uint8Array, start: number): void {
  const end = Math.min(bytes.length - 8, start + MAX_HEADER_BYTES);
  if (start + 10 > end || bytes[start] !== 31 || bytes[start + 1] !== 139 || bytes[start + 2] !== 8) {
    throw new Error('gzip: invalid or truncated header');
  }
  const flags = bytes[start + 3];
  if (flags & 0xe0) throw new Error('gzip: invalid reserved header flags');
  let offset = start + 10;
  if (flags & 4) {
    if (offset + 2 > end) throw new Error('gzip: truncated extra header');
    offset += 2 + bytes[offset] + (bytes[offset + 1] << 8);
  }
  for (const flag of [8, 16]) {
    if (flags & flag) {
      while (offset < end && bytes[offset] !== 0) offset++;
      if (offset >= end) throw new Error('gzip: header exceeds limit or is truncated');
      offset++;
    }
  }
  if (flags & 2) {
    if (offset + 2 > end) throw new Error('gzip: truncated header CRC');
    const expected = bytes[offset] | (bytes[offset + 1] << 8);
    if ((crc32(bytes.subarray(start, offset)) & 0xffff) !== expected) throw new Error('gzip: header CRC mismatch');
    offset += 2;
  }
  if (offset > end) throw new Error('gzip: header exceeds limit or is truncated');
}

/** Only the three zlib exports used by the pinned browser artifact are exposed. */
export function gunzipSync(input: Uint8Array, options: CodecOptions = {}): Uint8Array {
  const output = collector(outputLimit(input, options));
  validateHeader(input, 0);
  let memberBytes = 0;
  let memberCrc = 0xffffffff;
  let memberStart = 0;
  let members = 1;
  const validateTrailer = (end: number) => {
    if (end < memberStart + 18 || readUint32(input, end - 4) !== (memberBytes >>> 0)
      || readUint32(input, end - 8) !== ((memberCrc ^ 0xffffffff) >>> 0)) {
      throw new Error('gzip: integrity check failed (CRC or length)');
    }
  };
  const decoder = new Gunzip((chunk) => {
    output.add(chunk);
    memberBytes += chunk.length;
    memberCrc = updateCrc32(memberCrc, chunk);
  });
  decoder.onmember = (offset) => {
    validateTrailer(offset);
    if (++members > MAX_MEMBERS) throw new RangeError('gzip: too many concatenated members');
    validateHeader(input, offset);
    memberStart = offset;
    memberBytes = 0;
    memberCrc = 0xffffffff;
  };
  // Feed the last bytes as non-final too, so fflate visits every concatenated
  // member. The final empty push then checks the final deflate block.
  for (let offset = 0; offset < input.length; offset += INFLATE_CHUNK_BYTES) {
    decoder.push(input.subarray(offset, offset + INFLATE_CHUNK_BYTES), false);
  }
  decoder.push(new Uint8Array(), true);
  validateTrailer(input.length);
  return output.finish();
}

export function gzipSync(input: Uint8Array, options: CodecOptions = {}): Uint8Array {
  const output = collector(outputLimit(input, options));
  const level = options.level === undefined || options.level === -1 ? 6 : options.level;
  if (!Number.isInteger(level) || level < 0 || level > 9) throw new RangeError('gzip: invalid compression level');
  // Streaming caps compressor working storage; mem=4 avoids fflate's default
  // larger hash table. Timestamp zero makes output reproducible.
  const encoder = new Gzip({ level: level as GzipOptions['level'], mem: 4, mtime: 0 }, (chunk) => output.add(chunk));
  for (let offset = 0; offset < input.length; offset += 32 * 1024) {
    encoder.push(input.subarray(offset, offset + 32 * 1024), false);
  }
  encoder.push(new Uint8Array(), true);
  return output.finish();
}
