import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import type { IFileSystem } from 'just-bash/browser';
import { BoundedSystemFs } from './bounded-system-fs';
import { WorkspaceFileSystem } from './filesystem/index';
import { createMountedFileSystem } from './mounted-filesystem';

type Workspace = { files: WorkspaceFileSystem };
export type WorkspaceInvocation = {
  files: WorkspaceFileSystem;
  mounted: IFileSystem;
  signal: AbortSignal;
  /** Seal this invocation locally; its owner decides whether to return a result or throw. */
  abort(reason: unknown): void;
};

// Workspace IDs are globally unique. Managers created during lifecycle transitions
// must share the same invocation boundary even when they own different DB connections.
const workspaceQueues = new Map<string, Promise<unknown>>();

/** Owns a lazy database and an invocation queue per workspace; system files live for one call. */
export class WorkspaceRuntime {
  private database?: Promise<SqliteDatabase>;
  private readonly workspaces = new Map<string, Promise<Workspace>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private closing?: Promise<void>;
  private stopped = false;
  private readonly stopReason = new Error('Chat runtime closed during workspace execution.');

  constructor(private readonly openDatabase: () => Promise<SqliteDatabase>) {}

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
        return { files };
      })();
      this.workspaces.set(id, pending);
      // A failed initialization can be retried; the database owner still closes any opened connection.
      pending.catch(() => { if (this.workspaces.get(id) === pending) this.workspaces.delete(id); });
    }
    return pending;
  }

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
      const system = new BoundedSystemFs();
      system.mkdirSync('/tmp', { recursive: true });
      const mounted = createMountedFileSystem(system, files, controller.signal);
      try {
        const result = await execute({ files, mounted, signal: controller.signal, abort: (reason) => controller.abort(reason) });
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

  /** Stop admission immediately; both queued and active calls observe cancellation. */
  stop(): void {
    this.stopped = true;
    for (const controller of this.controllers) controller.abort(this.stopReason);
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.stop();
      this.closing = (async () => {
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
