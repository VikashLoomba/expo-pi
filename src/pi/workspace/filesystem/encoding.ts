import type { ReadFileOptions, WriteFileOptions } from './types';
import type { BufferEncoding, FileContent } from 'just-bash';
import { fsError } from './types';

type Options = ReadFileOptions | WriteFileOptions | BufferEncoding;
export function encodingOf(options?: Options): BufferEncoding | undefined {
  return typeof options === 'string' ? options : options?.encoding ?? undefined;
}
export function latin1(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return chunks.join('');
}
export function decode(bytes: Uint8Array, options?: Options): string {
  const encoding = encodingOf(options);
  if (encoding === 'base64') return btoa(latin1(bytes));
  if (encoding === 'hex') {
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      chunks.push(Array.from(bytes.subarray(offset, offset + 8192), (byte) => byte.toString(16).padStart(2, '0')).join(''));
    }
    return chunks.join('');
  }
  if (encoding === 'binary' || encoding === 'latin1') return latin1(bytes);
  // just-bash's FS codec treats ascii, utf8 and utf-8 identically.
  return new TextDecoder().decode(bytes);
}
export function encode(content: FileContent, options: Options | undefined, maximum: number): Uint8Array {
  const encoding = encodingOf(options);
  if (content instanceof Uint8Array) {
    if (content.byteLength > maximum) throw fsError('EFBIG', '', 'file size limit exceeded');
    return new Uint8Array(content);
  }
  const ratio = encoding === 'hex' ? 2 : encoding === 'base64' ? 2 : 1;
  if (content.length > maximum * ratio) throw fsError('EFBIG', '', 'encoded allocation limit exceeded');
  let bytes: Uint8Array;
  if (encoding === 'base64') bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  else if (encoding === 'hex') {
    bytes = new Uint8Array(Math.floor(content.length / 2));
    for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(content.slice(i * 2, i * 2 + 2), 16);
  } else if (encoding === 'binary' || encoding === 'latin1') {
    bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i);
  } else bytes = new TextEncoder().encode(content);
  if (bytes.byteLength > maximum) throw fsError('EFBIG', '', 'file size limit exceeded');
  return bytes;
}
