/** A scan may keep the workspace queue while allowing UI events and cancellation to run. */
export class CooperativeWork {
  private lastYield = Date.now();

  constructor(private readonly checkCancellation: () => void) {}

  async checkpoint(): Promise<void> {
    this.checkCancellation();
    if (Date.now() - this.lastYield < 8) return;
    await this.yield();
  }

  async yield(): Promise<void> {
    this.checkCancellation();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.lastYield = Date.now();
    this.checkCancellation();
  }
}

/** UTF-8 encoding and Unicode normalization must not split a surrogate pair. */
export function textChunkEnd(text: string, start: number, maximum = 65_536): number {
  let end = Math.min(text.length, start + maximum);
  const last = text.charCodeAt(end - 1);
  if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
  return end;
}
