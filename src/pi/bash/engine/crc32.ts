const table = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  table[value] = crc >>> 0;
}

export function updateCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = (crc >>> 8) ^ table[(crc ^ byte) & 255];
  return crc >>> 0;
}

export function crc32(bytes: Uint8Array): number {
  return (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}
