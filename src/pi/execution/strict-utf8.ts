import { FileError, toError } from '@earendil-works/pi-durable/env';

/**
 * Text that refuses invalid UTF-8, so pi's `edit` never rewrites a binary or Latin-1 file with U+FFFD. Like Node's
 * `readFile(path, 'utf8')`, a byte-order mark is kept.
 */
export function decodeStrictUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new FileError('invalid', 'File is not valid UTF-8 text.', path, toError(cause));
  }
}
