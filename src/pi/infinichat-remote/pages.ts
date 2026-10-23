/**
 * Page diffs of InfiniChat's database, shared by the phone and the server, so a move sends only the pages that
 * changed since the receiver's copy. An SQLite database file is a sequence of pages of the size its header names
 * (sqlite.org/fileformat.html, "Page Size"), and SQLite's backup API writes a copy's pages at the same page numbers,
 * so the pages whose SHA-256 differs turn the receiver's copy into the sender's file. Each side passes its own digest,
 * gzip and file access.
 */

/** Bytes over a plain `ArrayBuffer`, as both sides' file reads return them. */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface PagePlatform {
  sha256(bytes: Bytes): Promise<Bytes>;
  gzip(bytes: Bytes): Promise<Bytes>;
  gunzip(bytes: Bytes): Promise<Bytes>;
  /** The whole file. */
  read(path: string): Promise<Bytes>;
  /** Writes the file aside, then renames it into place. */
  write(path: string, bytes: Bytes): Promise<void>;
}

const HASH = 32;
// Both formats start with the page size (32 bits) and a file's size (a float64, exact for any size a file has).
const SIZES = 12;
// A patch then names the new file's SHA-256 and how many pages it carries.
const PAGE_NUMBERS = SIZES + HASH + 4;

/** The page size at byte 16 of the database header, big-endian; 1 stands for 65536. */
function pageSize(file: Bytes): number {
  const size = file.byteLength < 100 ? 0 : file[16] * 256 + file[17];
  if (size === 1) return 65_536;
  if (size < 512 || (size & (size - 1)) !== 0) throw new Error('The file is not an SQLite database.');
  return size;
}

const page = (file: Bytes, size: number, number: number) => file.subarray(number * size, (number + 1) * size);
const equal = (left: Bytes, right: Bytes) =>
  left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);

/** The page list of the database at `path`: its page size and size, then the SHA-256 of each page. */
export async function pages(platform: PagePlatform, path: string): Promise<Bytes> {
  const file = await platform.read(path);
  const size = pageSize(file);
  const count = Math.ceil(file.byteLength / size);
  const list = new Uint8Array(SIZES + count * HASH);
  const view = new DataView(list.buffer);
  view.setUint32(0, size);
  view.setFloat64(4, file.byteLength);
  for (let number = 0; number < count; number++) {
    list.set(await platform.sha256(page(file, size, number)), SIZES + number * HASH);
  }
  return list;
}

/**
 * The patch that turns the copy `list` describes into the database at `path`, gzipped: its page size, size and
 * SHA-256, the numbers of the pages that changed, then those pages. A page changed when it is past the copy's end or
 * its hash differs; a copy of another page size shares none.
 */
export async function diff(platform: PagePlatform, path: string, list: Bytes): Promise<Bytes> {
  const file = await platform.read(path);
  const size = pageSize(file);
  const listed = new DataView(list.buffer, list.byteOffset, list.byteLength);
  const known = listed.getUint32(0) === size ? (list.byteLength - SIZES) / HASH : 0;
  const changed: number[] = [];
  for (let number = 0; number * size < file.byteLength; number++) {
    const at = SIZES + number * HASH;
    if (number >= known || !equal(await platform.sha256(page(file, size, number)), list.subarray(at, at + HASH))) {
      changed.push(number);
    }
  }
  const body = PAGE_NUMBERS + changed.length * 4;
  const patch = new Uint8Array(body + changed.length * size);
  const view = new DataView(patch.buffer);
  view.setUint32(0, size);
  view.setFloat64(4, file.byteLength);
  patch.set(await platform.sha256(file), SIZES);
  view.setUint32(SIZES + HASH, changed.length);
  changed.forEach((number, index) => {
    view.setUint32(PAGE_NUMBERS + index * 4, number);
    patch.set(page(file, size, number), body + index * size);
  });
  return platform.gzip(patch);
}

/**
 * Puts the patch's pages into the file at `base`, cut or extended to the new size, and writes the result to `out`
 * once its SHA-256 is the one the patch names. A patch made against another base fails here and leaves `out` as it
 * was.
 */
export async function apply(platform: PagePlatform, base: string, patch: Bytes, out: string): Promise<void> {
  const raw = await platform.gunzip(patch);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const size = view.getUint32(0);
  const length = view.getFloat64(4);
  const count = view.getUint32(SIZES + HASH);
  const body = PAGE_NUMBERS + count * 4;
  const file = new Uint8Array(Math.ceil(length / size) * size);
  file.set((await platform.read(base)).subarray(0, file.byteLength));
  for (let index = 0; index < count; index++) {
    file.set(page(raw.subarray(body), size, index), view.getUint32(PAGE_NUMBERS + index * 4) * size);
  }
  const result = file.subarray(0, length);
  if (!equal(await platform.sha256(result), raw.subarray(SIZES, SIZES + HASH))) {
    throw new Error('The patched copy doesn’t match the database it was made from.');
  }
  await platform.write(out, result);
}
