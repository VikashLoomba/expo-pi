import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { uuidv7 } from '@earendil-works/pi-ai';
import type { IFileSystem } from 'just-bash/browser';
import { BoundedSystemFs } from './bounded-system-fs';
import { WorkspaceFileSystem } from './filesystem/index';
import { createMountedFileSystem } from './mounted-filesystem';

type Workspace = { files: WorkspaceFileSystem; system: BoundedSystemFs };
export type WorkspaceResource = { stop(reason: unknown): void; close(): Promise<void> };
export type WorkspaceInvocation = {
  id: string;
  files: WorkspaceFileSystem;
  mounted: IFileSystem;
  system: BoundedSystemFs;
  signal: AbortSignal;
  /** Seal this invocation locally; its owner decides whether to return a result or throw. */
  abort(reason: unknown): void;
};

// Workspace IDs are globally unique. Managers created during lifecycle transitions
// must share the same invocation boundary even when they own different DB connections.
const workspaceQueues = new Map<string, Promise<unknown>>();

/** Owns a lazy database, bounded system tree and invocation queue per workspace. */
export class WorkspaceRuntime {
  private readonly namespace = uuidv7();
  private database?: Promise<SqliteDatabase>;
  private readonly workspaces = new Map<string, Promise<Workspace>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private closing?: Promise<void>;
  private readonly resources = new Set<WorkspaceResource>();
  private stopped = false;
  private readonly stopReason = new Error('Chat runtime closed during workspace execution.');

  constructor(private readonly openDatabase: () => Promise<SqliteDatabase>) {}

  get isStopped(): boolean { return this.stopped; }

  /** Cwd views and scopes share files; a new runtime starts a new temporary namespace. */
  namespaceId(workspaceId: string): string { return `workspace:${this.namespace}:${workspaceId}`; }

  private connection(): Promise<SqliteDatabase> {
    if (!this.database) {
      const pending = this.openDatabase();
      this.database = pending;
      pending.catch(() => { if (this.database === pending) this.database = undefined; });
    }
    return this.database;
  }

  private async workspace(id: string): Promise<Workspace> {
    let pending = this.workspaces.get(id);
    if (!pending) {
      pending = (async () => {
        const files = await WorkspaceFileSystem.open(await this.connection(), id, { mountPath: '/workspace' });
        const system = new BoundedSystemFs();
        system.mkdirSync('/tmp', { recursive: true });
        return { files, system };
      })();
      this.workspaces.set(id, pending);
      // A failed initialization can be retried; the database owner still closes any opened connection.
      pending.catch(() => { if (this.workspaces.get(id) === pending) this.workspaces.delete(id); });
    }
    return pending;
  }

  /** Active direct environments register lazily; metadata facades require no ownership. */
  own(resource: WorkspaceResource): () => void {
    if (this.stopped) throw new Error('Workspace runtime is closing.');
    this.resources.add(resource);
    return () => { this.resources.delete(resource); };
  }

  /** Each operation gets its own cancellation facade over the workspace's shared files. */
  run<T>(id: string, signal: AbortSignal | undefined, execute: (invocation: WorkspaceInvocation) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Workspace runtime is closing.'));
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    this.controllers.add(controller);
    const previous = workspaceQueues.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      controller.signal.throwIfAborted();
      const workspace = await this.workspace(id);
      controller.signal.throwIfAborted();
      await workspace.files.refresh();
      controller.signal.throwIfAborted();
      const files = workspace.files.forInvocation(controller.signal);
      const { system } = workspace;
      const mounted = createMountedFileSystem(system, files, controller.signal);
      try {
        const result = await execute({ id: this.namespaceId(id), files, mounted, system,
          signal: controller.signal, abort: (reason) => controller.abort(reason) });
        // An invocation may handle its local cancellation and return a result.
        // Caller cancellation and app closure always retain cancellation identity.
        signal?.throwIfAborted();
        if (this.stopped) throw this.stopReason;
        return result;
      } finally {
        // Seal writes even if the caller abandoned an asynchronous operation.
        controller.abort(new Error('Workspace invocation has ended.'));
        await files.drain();
      }
    });
    workspaceQueues.set(id, operation);
    this.queues.set(id, operation);
    const finish = () => {
      signal?.removeEventListener('abort', forwardAbort);
      this.controllers.delete(controller);
      if (workspaceQueues.get(id) === operation) workspaceQueues.delete(id);
      if (this.queues.get(id) === operation) this.queues.delete(id);
    };
    operation.then(finish, finish);
    return operation;
  }

  /** Acquire one whole-call lease. Releasing it seals writes and awaits storage drain. */
  async acquire(id: string, signal?: AbortSignal): Promise<{ invocation: WorkspaceInvocation; release(): Promise<void> }> {
    let acquired!: (invocation: WorkspaceInvocation) => void;
    let failed!: (reason: unknown) => void;
    let release!: () => void;
    const ready = new Promise<WorkspaceInvocation>((resolve, reject) => { acquired = resolve; failed = reject; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const operation = this.run(id, signal, async (invocation) => { acquired(invocation); await held; });
    // Attach immediately, including admission failures before the lease is available.
    operation.catch(failed);
    const invocation = await ready;
    return { invocation, release: async () => { release(); await operation; } };
  }

  /** Stop admission immediately; both queued and active calls observe cancellation. */
  stop(): void {
    this.stopped = true;
    for (const resource of this.resources) resource.stop(this.stopReason);
    for (const controller of this.controllers) controller.abort(this.stopReason);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stop();
      this.closing = (async () => {
        await Promise.allSettled([...this.resources].map((resource) => resource.close()));
        await Promise.allSettled([...this.queues.values()]);
        if (this.database) {
          // A rejected factory owns its own failure cleanup and has no handle to close.
          const database = await this.database.catch(() => undefined);
          await database?.close();
        }
        this.workspaces.clear();
      })();
    }
    return this.closing;
  }
}
