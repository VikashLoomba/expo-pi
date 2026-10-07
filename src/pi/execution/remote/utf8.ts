import { Buffer } from 'buffer';

/** Incremental UTF-8 without Hermes-dependent TextDecoder streaming/BOM options. */
export class MobileUtf8Decoder {
  private carry = new Uint8Array(0);
  private started = false;
  constructor(private readonly dropLeadingBom = false) {}

  write(input: Uint8Array): string {
    const bytes = this.carry.length ? Buffer.concat([this.carry, input]) : input;
    let end = bytes.length;
    let start = end - 1;
    while (start >= 0 && start >= end - 3 && (bytes[start]! & 0xc0) === 0x80) start--;
    if (start >= 0) {
      const first = bytes[start]!;
      const width = first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3
        : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
      const second = bytes[start + 1];
      const validSecond = second === undefined || ((second & 0xc0) === 0x80
        && !(first === 0xe0 && second < 0xa0) && !(first === 0xed && second >= 0xa0)
        && !(first === 0xf0 && second < 0x90) && !(first === 0xf4 && second >= 0x90));
      if (end - start < width && validSecond) end = start;
    }
    this.carry = Uint8Array.from(bytes.subarray(end));
    return this.deliver(Buffer.from(bytes.buffer, bytes.byteOffset, end).toString('utf8'));
  }

  end(input?: Uint8Array): string {
    let text = input === undefined ? '' : this.write(input);
    text += this.deliver(Buffer.from(this.carry).toString('utf8'));
    this.carry = new Uint8Array(0);
    return text;
  }

  private deliver(text: string): string {
    if (this.started || !text) return text;
    this.started = true;
    return this.dropLeadingBom && text.startsWith('\ufeff') ? text.slice(1) : text;
  }
}
