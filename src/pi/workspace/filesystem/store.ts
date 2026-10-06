import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import { initialize } from './schema';
import { retainedInodeCount } from './opened-inodes';
import { abortIfNeeded, entryKey, fsError, limitsFor } from './types';
import type { Entry, NamespaceCache, Operation, WorkspaceOptions } from './types';

const owners = new WeakMap<SqliteDatabase, Store>();
export class Store {
  private tail: Promise<void> = Promise.resolve();
  private ready?: Promise<void>;
  private queuedBytes = 0;
  readonly caches = new Map<string, NamespaceCache>();
  readonly database: SqliteDatabase;
  constructor(database: SqliteDatabase) { this.database = database; }
  static for(database: SqliteDatabase): Store {
    let owner = owners.get(database);
    if (!owner) { owner = new Store(database); owners.set(database, owner); }
    return owner;
  }
  enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
  drain(): Promise<void> { return this.tail; }
  initialize(): Promise<void> {
    if (!this.ready) {
      const pending = initialize(this.database);
      this.ready = pending;
      pending.catch(() => { if (this.ready === pending) this.ready = undefined; });
    }
    return this.ready;
  }
  async open(workspace: string, options: WorkspaceOptions, create = true): Promise<NamespaceCache> {
    if (!workspace || workspace.length > 128 || workspace.includes('\0')) throw fsError('EINVAL', workspace, 'invalid workspace identifier');
    await this.initialize();
    return this.enqueue(async () => this.database.transaction(async (sql) => {
      let row = await sql.get<{ root: number }>('SELECT root FROM workspaces WHERE id=?', workspace);
      if (!row) {
        if (!create) throw fsError('ENOENT', workspace, 'workspace was deleted');
        const count = (await sql.get<{ count: number }>('SELECT COUNT(*) AS count FROM workspaces'))!.count;
        if (count >= limitsFor(options).maxWorkspaces) throw fsError('ENOSPC', workspace, 'workspace count limit exceeded');
        const entries = (await sql.get<{ count: number }>('SELECT COALESCE(SUM(entry_count+1),0) AS count FROM workspaces'))!.count;
        if (entries >= limitsFor(options).maxDatabaseEntries) throw fsError('ENOSPC', workspace, 'database namespace limit exceeded');
        await sql.run('INSERT INTO workspaces(id,created) VALUES (?,?)', workspace, Date.now());
        await sql.run("INSERT INTO inodes(workspace_id,kind,mode,mtime,size) VALUES (?,'directory',493,?,0)", workspace, Date.now());
        const root = (await sql.get<{ id: number }>('SELECT last_insert_rowid() AS id'))!.id;
        await sql.run('UPDATE workspaces SET root=? WHERE id=?', root, workspace);
        row = { root };
      }
      // A process crash releases open handles. Reclaim orphan file rows lazily,
      // while preserving handles owned by another live runtime/connection.
      const orphans = await sql.all<{ id: number }>(
        'SELECT id FROM inodes WHERE workspace_id=? AND id<>? AND NOT EXISTS(SELECT 1 FROM entries WHERE entries.workspace_id=inodes.workspace_id AND entries.inode=inodes.id)', workspace, row.root);
      for (const orphan of orphans) {
        if (!retainedInodeCount(workspace, orphan.id)) await sql.run('DELETE FROM inodes WHERE workspace_id=? AND id=?', workspace, orphan.id);
      }
      const entries = await sql.all<Entry>('SELECT parent,name,inode FROM entries WHERE workspace_id=?', workspace);
      if (entries.length + 1 > limitsFor(options).maxEntries) throw fsError('ENOSPC', '/', 'namespace exceeds configured limit');
      const previous = this.caches.get(workspace);
      const cache = previous?.root === row.root ? previous : { root: row.root, entries: new Map() };
      cache.root = row.root;
      cache.entries = new Map(entries.map((entry) => [entryKey(entry.parent, entry.name), entry]));
      this.caches.set(workspace, cache);
      return cache;
    }));
  }
  run<T>(workspace: string, options: WorkspaceOptions, signal: AbortSignal | undefined, mutation: boolean,
    work: (operation: Operation) => Promise<T>, expectedRoot: number, allocation = 0): Promise<T> {
    abortIfNeeded(signal);
    if (this.queuedBytes + allocation > limitsFor(options).maxQueuedBytes) throw fsError('ENOSPC', '/', 'queued filesystem allocation limit exceeded');
    this.queuedBytes += allocation;
    const result = this.enqueue(async () => {
      abortIfNeeded(signal);
      const changes: Operation['changes'] = [];
      const result = await this.database.transaction(async (transaction) => {
        let steps = 0;
        const limits = limitsFor(options);
        const check = () => {
          abortIfNeeded(signal);
          if (++steps > limits.maxOperationSteps) throw fsError('ELOOP', '', 'filesystem operation work limit exceeded');
        };
        const sql: SqliteExecutor = {
          exec: async (query) => { check(); await transaction.exec(query); },
          run: async (query, ...values) => { check(); await transaction.run(query, ...values); },
          get: async <R extends object>(query: string, ...values: SqliteValue[]) => { check(); return transaction.get<R>(query, ...values); },
          all: async <R extends object>(query: string, ...values: SqliteValue[]) => { check(); return transaction.all<R>(query, ...values); },
        };
        const namespace = await sql.get<{ root: number }>('SELECT root FROM workspaces WHERE id=?', workspace);
        if (!namespace) throw fsError('ENOENT', workspace, 'workspace was deleted');
        if (namespace.root !== expectedRoot) throw fsError('ESTALE', workspace, 'workspace was replaced');
        const value = await work({ sql, workspace, root: namespace.root, limits, mountPath: options.mountPath ?? '/', check, changes });
        if (mutation) {
          const usage = (await sql.get<{ bytes: number; entry_count: number; inode_count: number }>(
            'SELECT bytes,entry_count,inode_count FROM workspaces WHERE id=?', workspace))!;
          if (usage.bytes > limits.maxTotalBytes || usage.entry_count + 1 > limits.maxEntries || usage.inode_count > limits.maxEntries) {
            throw fsError('ENOSPC', '/', 'workspace storage or namespace limit exceeded');
          }
        }
        check();
        return value;
      });
      const cache = this.caches.get(workspace);
      if (cache) for (const change of changes) change(cache);
      return result;
    });
    return result.finally(() => { this.queuedBytes -= allocation; });
  }
}
