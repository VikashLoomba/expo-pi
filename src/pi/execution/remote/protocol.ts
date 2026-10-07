import { Buffer } from 'buffer';

export type Json = Record<string, unknown>;
export const FrameType = { request: 1, result: 2, error: 3, event: 4, cancel: 5, ping: 6 } as const;
export const MAX_FRAME = 16 * 1024 * 1024;

/** Hermes versions differ in toWellFormed support; UTF-8 encoding has Node's replacement behavior. */
function wellFormed(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? Buffer.from(value, 'utf8').toString('utf8') : value;
}

export function encodeFrame(type: number, id: number, json: Json, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const body = Buffer.from(JSON.stringify(json, wellFormed), 'utf8');
  const length = 9 + body.length + payload.length;
  if (length > MAX_FRAME) throw new Error('Pi protocol frame exceeds 16 MiB.');
  const bytes = Buffer.alloc(4 + length);
  bytes.writeUInt32BE(length, 0);
  bytes.writeUInt8(type, 4);
  bytes.writeUInt32BE(id, 5);
  bytes.writeUInt32BE(body.length, 9);
  bytes.set(body, 13);
  bytes.set(payload, 13 + body.length);
  return bytes;
}

export interface Frame { type: number; id: number; json: Json; payload: Uint8Array }

/** Incremental framed parsing with a bounded synchronization prefix and owned binary payloads. */
export class FrameDecoder {
  readonly #marker: Uint8Array;
  #matched = 0;
  #synced = false;
  #chunks: Uint8Array[] = [];
  #buffered = 0;

  constructor(token: string) { this.#marker = Buffer.from(`PI-ENV ${token}\n`, 'utf8'); }

  push(chunk: Uint8Array, receive: (frame: Frame) => void): void {
    let offset = 0;
    if (!this.#synced) {
      // The marker has no repeated initial P, so a failed match can restart at
      // the current byte. Noise is discarded immediately, never accumulated.
      while (offset < chunk.length && !this.#synced) {
        const byte = chunk[offset++];
        this.#matched = byte === this.#marker[this.#matched] ? this.#matched + 1 : byte === this.#marker[0] ? 1 : 0;
        this.#synced = this.#matched === this.#marker.length;
      }
    }
    if (!this.#synced || offset === chunk.length) return;
    // Copy again at the portable boundary: injected transports have the same lifetime guarantee.
    const retained = new Uint8Array(chunk.subarray(offset));
    this.#chunks.push(retained);
    this.#buffered += retained.length;
    while (this.#buffered >= 4) {
      const header = this.#peek(4);
      const length = header.readUInt32BE(0);
      if (length < 9 || length > MAX_FRAME) throw new Error('Invalid Pi protocol frame length.');
      if (this.#buffered < 4 + length) return;
      const bytes = this.#peek(4 + length);
      const type = bytes.readUInt8(4);
      const id = bytes.readUInt32BE(5);
      const jsonLength = bytes.readUInt32BE(9);
      if (jsonLength > length - 9) throw new Error('Invalid Pi protocol JSON length.');
      // Never call toString on a subarray: Hermes may return Uint8Array there.
      const parsed: unknown = JSON.parse(bytes.toString('utf8', 13, 13 + jsonLength));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Pi protocol JSON object.');
      const payload = new Uint8Array(bytes.subarray(13 + jsonLength, 4 + length));
      this.#consume(4 + length);
      receive({ type, id, json: parsed as Json, payload });
    }
  }

  #peek(length: number): Buffer {
    const first = this.#chunks[0]!;
    if (first.length >= length) return Buffer.from(first.buffer, first.byteOffset, length);
    const joined = Buffer.concat(this.#chunks, this.#buffered);
    this.#chunks = [joined];
    return joined;
  }

  #consume(length: number): void {
    this.#buffered -= length;
    while (length > 0) {
      const first = this.#chunks[0]!;
      if (first.length <= length) { this.#chunks.shift(); length -= first.length; }
      else { this.#chunks[0] = first.subarray(length); length = 0; }
    }
  }
}
