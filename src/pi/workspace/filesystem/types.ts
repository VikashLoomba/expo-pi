import type { SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import type { BufferEncoding } from 'just-bash';
export interface ReadFileOptions { encoding?: BufferEncoding | null }
export interface WriteFileOptions { encoding?: BufferEncoding }

export interface WorkspaceLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDatabaseBytes: number;
  maxDatabaseEntries: number;
  maxWorkspaces: number;
  maxQueuedBytes: number;
  maxEntries: number;
  maxPathLength: number;
  maxDepth: number;
  maxSymlinks: number;
  maxOperationSteps: number;
}
export const DEFAULT_WORKSPACE_LIMITS: Readonly<WorkspaceLimits> = Object.freeze({
  maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024,
  maxDatabaseBytes: 256 * 1024 * 1024, maxDatabaseEntries: 16384,
  maxWorkspaces: 1024, maxQueuedBytes: 16 * 1024 * 1024,
  maxEntries: 4096, maxPathLength: 4096, maxDepth: 128,
  maxSymlinks: 40, maxOperationSteps: 65536,
});
export interface WorkspaceOptions {
  limits?: Partial<WorkspaceLimits>;
  /** Guest mount point; needed because MountableFs preserves symlink targets verbatim. */
  mountPath?: string;
}
export type Kind = 'file' | 'directory' | 'symlink';
export interface Inode {
  id: number; workspace_id: string; kind: Kind; mode: number;
  mtime: number; size: number; target: string | null;
}
export interface Entry { parent: number; name: string; inode: number }
export interface Location { inode: Inode; parent?: number; name?: string; path: string }
export interface NamespaceCache { root: number; entries: Map<string, Entry> }
export interface Operation {
  sql: SqliteExecutor; workspace: string; root: number; limits: WorkspaceLimits; mountPath: string;
  check(): void;
  changes: ((cache: NamespaceCache) => void)[];
}
export function entryKey(parent: number, name: string): string { return `${parent}:${name}`; }
export function fsError(code: string, path: string, detail = ''): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${detail || code} '${path}'`), { code });
}
export function abortIfNeeded(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
export function limitsFor(options: WorkspaceOptions = {}): WorkspaceLimits {
  const limits = { ...DEFAULT_WORKSPACE_LIMITS, ...options.limits };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Workspace limits must be positive safe integers');
  }
  return limits;
}
