import { InMemoryFs, type FsStat } from 'just-bash/browser';

export const SYSTEM_FS_LIMITS = Object.freeze({
  maxTotalBytes: 4 * 1024 * 1024,
  maxEntries: 1024,
  maxPathLength: 4096,
  maxDepth: 64,
});

type SystemLimits = typeof SYSTEM_FS_LIMITS;

/**
 * One instance belongs to a workspace for its runtime's lifetime. Upstream bounds
 * file bodies but not empty files, directory entries or link targets; bound that metadata too.
 * Synchronous methods are necessary for Bash's /bin and /proc initialization.
 */
export class BoundedSystemFs extends InMemoryFs {
  private readonly limits: SystemLimits;
  private readonly openHandles = new Set<{ path: string; bytes?: Uint8Array; stat?: FsStat }>();

  /** Live opened-file handles, updated by rename and retained independently after unlink. */
  async openReadHandle(path: string) {
    const record: { path: string; bytes?: Uint8Array; stat?: FsStat } = { path: await this.realpath(path) };
    this.openHandles.add(record);
    return {
      info: () => record.stat ? Promise.resolve(record.stat) : this.stat(record.path),
      read: async (offset: number, length: number) => (record.bytes ?? await this.readFileBuffer(record.path)).slice(offset, offset + length),
      close: async () => { this.openHandles.delete(record); record.bytes = undefined; record.stat = undefined; },
    };
  }

  private async retainRemoved(path: string): Promise<() => void> {
    const records = [...this.openHandles].filter((record) => !record.bytes && (record.path === path || record.path.startsWith(`${path}/`)));
    const snapshots = new Map<string, { bytes: Uint8Array; stat: FsStat }>();
    for (const record of records) {
      if (!snapshots.has(record.path)) snapshots.set(record.path, { bytes: await this.readFileBuffer(record.path), stat: await this.stat(record.path) });
    }
    const retained = new Set([...this.openHandles].flatMap((record) => record.bytes ? [record.bytes] : []));
    const bytes = [...retained].reduce((sum, bytes) => sum + bytes.length, 0)
      + [...snapshots.values()].reduce((sum, snapshot) => sum + snapshot.bytes.length, 0);
    if (bytes > this.limits.maxTotalBytes) throw Object.assign(new Error('ENOSPC: open temporary reader retention limit exceeded'), { code: 'ENOSPC' });
    return () => { for (const record of records) Object.assign(record, snapshots.get(record.path)); };
  }

  override async rm(...args: Parameters<InMemoryFs['rm']>): Promise<void> {
    const retained = await this.retainRemoved(this.path(args[0]));
    await super.rm(...args);
    retained();
  }

  constructor(limits: Partial<SystemLimits> = {}) {
    const resolved = { ...SYSTEM_FS_LIMITS, ...limits };
    for (const value of Object.values(resolved)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid system filesystem limit');
    }
    super(undefined, { maxTotalBytes: resolved.maxTotalBytes });
    this.limits = resolved;
  }

  private path(path: string): string {
    if (typeof path !== 'string' || !path || path.includes('\0')) {
      throw Object.assign(new Error('EINVAL: invalid system filesystem path'), { code: 'EINVAL' });
    }
    if (path.length > this.limits.maxPathLength) {
      throw Object.assign(new Error('ENAMETOOLONG: system filesystem path limit exceeded'), { code: 'ENAMETOOLONG' });
    }
    const normalized = this.resolvePath('/', path);
    if (normalized.length > this.limits.maxPathLength
      || normalized.split('/').filter(Boolean).length > this.limits.maxDepth) {
      throw Object.assign(new Error('ENAMETOOLONG: system filesystem path limit exceeded'), { code: 'ENAMETOOLONG' });
    }
    return normalized;
  }

  private admit(paths: string[]): void {
    // This scan itself is bounded: every entry-producing method checks before
    // insertion, including the parents automatically created by upstream.
    const existing = new Set(super.getAllPaths());
    for (const path of paths) {
      const parts = this.path(path).split('/').filter(Boolean);
      let parent = '';
      for (const part of parts) {
        parent += `/${part}`;
        existing.add(parent);
        if (existing.size > this.limits.maxEntries) {
          throw Object.assign(new Error('ENOSPC: system filesystem entry limit exceeded'), { code: 'ENOSPC' });
        }
      }
    }
  }

  private admitTree(source: string, destination: string): void {
    const from = this.path(source);
    const to = this.path(destination);
    const prefix = from === '/' ? '/' : `${from}/`;
    const additions = [to];
    for (const path of super.getAllPaths()) {
      if (path.startsWith(prefix) && path !== from) additions.push(`${to}/${path.slice(prefix.length)}`);
    }
    this.admit(additions);
  }

  override writeFileSync(...args: Parameters<InMemoryFs['writeFileSync']>): void {
    this.admit([args[0]]);
    super.writeFileSync(...args);
  }

  override writeFileLazy(...args: Parameters<InMemoryFs['writeFileLazy']>): void {
    this.admit([args[0]]);
    super.writeFileLazy(...args);
  }

  override mkdirSync(...args: Parameters<InMemoryFs['mkdirSync']>): void {
    this.admit([args[0]]);
    super.mkdirSync(...args);
  }

  override async createExclusive(...args: Parameters<InMemoryFs['createExclusive']>): Promise<void> {
    const path = this.path(args[0]);
    const parent = await super.realpath(path.slice(0, path.lastIndexOf('/')) || '/');
    this.admit([`${parent}/${path.slice(path.lastIndexOf('/') + 1)}`]);
    return super.createExclusive(...args);
  }

  override async cp(...args: Parameters<InMemoryFs['cp']>): Promise<void> {
    this.admitTree(args[0], args[1]);
    return super.cp(...args);
  }

  override async mv(...args: Parameters<InMemoryFs['mv']>): Promise<void> {
    // Upstream creates destination directories before removing source entries.
    // Count both trees so the transient namespace is bounded as well.
    this.admitTree(args[0], args[1]);
    const from = this.path(args[0]), to = this.path(args[1]);
    const moving = [...this.openHandles].filter((record) => !record.bytes && (record.path === from || record.path.startsWith(`${from}/`)));
    const retained = from !== to ? await this.retainRemoved(to) : undefined;
    await super.mv(...args);
    retained?.();
    for (const record of moving) record.path = `${to}${record.path.slice(from.length)}`;
  }

  override async symlink(...args: Parameters<InMemoryFs['symlink']>): Promise<void> {
    this.path(args[0]); // Link targets retain strings even when they dangle.
    this.admit([args[1]]);
    return super.symlink(...args);
  }

  override async link(...args: Parameters<InMemoryFs['link']>): Promise<void> {
    this.path(args[0]);
    // Materialize a possible lazy source before admission. Upstream then has no
    // await between the namespace check and inserting the new hard-link entry.
    await super.readFileBuffer(args[0]);
    this.admit([args[1]]);
    return super.link(...args);
  }
}
