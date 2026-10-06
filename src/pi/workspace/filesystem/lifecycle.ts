import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';
import { Store } from './store';
import { fsError, limitsFor } from './types';
import type { Entry, WorkspaceOptions } from './types';

/** Atomic current-state copy; intentionally not a historical conversation snapshot. */
export async function copyWorkspace(database: SqliteDatabase, source: string, destination: string, options: WorkspaceOptions = {}): Promise<void> {
  if (!destination || destination.length > 128 || destination.includes('\0')) throw fsError('EINVAL', destination);
  const owner = Store.for(database);
  await owner.initialize();
  await owner.enqueue(() => database.transaction(async (sql) => {
    const workspace = await sql.get<{ root: number; bytes: number; entry_count: number }>('SELECT root,bytes,entry_count FROM workspaces WHERE id=?', source);
    if (!workspace) throw fsError('ENOENT', source);
    if (await sql.get('SELECT 1 FROM workspaces WHERE id=?', destination)) throw fsError('EEXIST', destination);
    // Open unlinked files belong to their readers, not to a filesystem copy.
    const liveNodes = await sql.all<{ id: number; size: number }>(
      'SELECT id,size FROM inodes WHERE workspace_id=? AND (id=? OR EXISTS(SELECT 1 FROM entries WHERE entries.workspace_id=inodes.workspace_id AND entries.inode=inodes.id)) ORDER BY id', source, workspace.root);
    const copyBytes = liveNodes.reduce((total, node) => total + node.size, 0);
    const limits = limitsFor(options);
    const usage = (await sql.get<{ bytes: number; count: number; entries: number }>('SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count,COALESCE(SUM(entry_count+1),0) AS entries FROM workspaces'))!;
    if (usage.count >= limits.maxWorkspaces || usage.bytes + copyBytes > limits.maxDatabaseBytes || usage.entries + workspace.entry_count + 1 > limits.maxDatabaseEntries) {
      throw fsError('ENOSPC', destination, 'database capacity exceeded');
    }
    if (copyBytes > limits.maxTotalBytes || workspace.entry_count + 1 > limits.maxEntries) throw fsError('ENOSPC', destination);
    if (liveNodes.some((node) => node.size > limits.maxFileBytes)) throw fsError('EFBIG', destination);
    await sql.run('INSERT INTO workspaces(id,created) VALUES (?,?)', destination, Date.now());
    const ids = new Map<number, number>();
    for (const node of liveNodes) {
      await sql.run('INSERT INTO inodes(workspace_id,kind,mode,mtime,size,data,target) SELECT ?,kind,mode,mtime,size,data,target FROM inodes WHERE workspace_id=? AND id=?', destination, source, node.id);
      ids.set(node.id, (await sql.get<{ id: number }>('SELECT last_insert_rowid() AS id'))!.id);
    }
    for (const entry of await sql.all<Entry>('SELECT parent,name,inode FROM entries WHERE workspace_id=?', source)) {
      await sql.run('INSERT INTO entries(workspace_id,parent,name,inode) VALUES (?,?,?,?)', destination, ids.get(entry.parent)!, entry.name, ids.get(entry.inode)!);
    }
    await sql.run('UPDATE workspaces SET root=? WHERE id=?', ids.get(workspace.root)!, destination);
  }));
}
export async function deleteWorkspace(database: SqliteDatabase, workspace: string): Promise<void> {
  const owner = Store.for(database);
  await owner.initialize();
  await owner.enqueue(async () => {
    await database.transaction(async (sql) => { await sql.run('DELETE FROM workspaces WHERE id=?', workspace); });
    const cache = owner.caches.get(workspace);
    cache?.entries.clear();
    owner.caches.delete(workspace);
  });
}
