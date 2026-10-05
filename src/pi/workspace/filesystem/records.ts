import { entryKey, fsError } from './types';
import type { Entry, Inode, Kind, Operation } from './types';
import { inode } from './paths';

export async function capacity(op: Operation, bytes = 0, entries = 0, inodes = 0): Promise<void> {
  const usage = (await op.sql.get<{ bytes: number; entry_count: number; inode_count: number }>(
    'SELECT bytes,entry_count,inode_count FROM workspaces WHERE id=?', op.workspace))!;
  if (usage.bytes + bytes > op.limits.maxTotalBytes || usage.entry_count + entries + 1 > op.limits.maxEntries || usage.inode_count + inodes > op.limits.maxEntries) {
    throw fsError('ENOSPC', '/', 'workspace storage or namespace limit exceeded');
  }
  if (bytes > 0) {
    const total = (await op.sql.get<{ bytes: number }>('SELECT COALESCE(SUM(bytes),0) AS bytes FROM workspaces'))!.bytes;
    if (total + bytes > op.limits.maxDatabaseBytes) throw fsError('ENOSPC', '/', 'database storage limit exceeded');
  }
  if (entries > 0) {
    const total = (await op.sql.get<{ count: number }>('SELECT COALESCE(SUM(entry_count+1),0) AS count FROM workspaces'))!.count;
    if (total + entries > op.limits.maxDatabaseEntries) throw fsError('ENOSPC', '/', 'database namespace limit exceeded');
  }
}
export async function newInode(op: Operation, kind: Kind, mode: number, data?: Uint8Array, target?: string, mtime = Date.now()): Promise<Inode> {
  const size = data?.byteLength ?? (target ? new TextEncoder().encode(target).byteLength : 0);
  if (size > op.limits.maxFileBytes) throw fsError('EFBIG', '', 'file size limit exceeded');
  await capacity(op, size, 0, 1);
  // Some native/JS SQLite bridges bind a zero-length external buffer as NULL.
  // Explicit zeroblob preserves the regular-file BLOB invariant on every bridge.
  await op.sql.run("INSERT INTO inodes(workspace_id,kind,mode,mtime,size,data,target) VALUES (?,?,?,?,?,CASE WHEN ?='file' AND ?=0 THEN zeroblob(0) ELSE ? END,?)",
    op.workspace, kind, mode, mtime, size, kind, size, kind === 'file' ? data ?? new Uint8Array() : null, target ?? null);
  const id = (await op.sql.get<{ id: number }>('SELECT last_insert_rowid() AS id'))!.id;
  return inode(op, id);
}
export async function addEntry(op: Operation, parent: number, name: string, id: number): Promise<void> {
  await capacity(op, 0, 1);
  // The unique namespace key enforces the exclusive create/rename contract.
  try {
    await op.sql.run('INSERT INTO entries(workspace_id,parent,name,inode) VALUES (?,?,?,?)', op.workspace, parent, name, id);
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) throw fsError('EEXIST', name);
    throw error;
  }
  op.changes.push((cache) => cache.entries.set(entryKey(parent, name), { parent, name, inode: id }));
  await touchParent(op, parent);
}
export async function removeEntry(op: Operation, parent: number, name: string, id: number): Promise<void> {
  await op.sql.run('DELETE FROM entries WHERE workspace_id=? AND parent=? AND name=?', op.workspace, parent, name);
  await op.sql.run('DELETE FROM inodes WHERE workspace_id=? AND id=? AND id<>? AND NOT EXISTS(SELECT 1 FROM entries WHERE workspace_id=? AND inode=?)',
    op.workspace, id, op.root, op.workspace, id);
  op.changes.push((cache) => cache.entries.delete(entryKey(parent, name)));
  await touchParent(op, parent);
}
export async function touchParent(op: Operation, parent: number): Promise<void> {
  await op.sql.run('UPDATE inodes SET mtime=? WHERE workspace_id=? AND id=?', Date.now(), op.workspace, parent);
}
export async function children(op: Operation, parent: number): Promise<Entry[]> {
  return op.sql.all<Entry>('SELECT parent,name,inode FROM entries WHERE workspace_id=? AND parent=? ORDER BY name', op.workspace, parent);
}
export async function bytesFor(op: Operation, node: Inode): Promise<Uint8Array> {
  if (node.kind !== 'file') throw fsError('EISDIR', '', 'not a regular file');
  if (node.size > op.limits.maxFileBytes) throw fsError('EFBIG', '', 'file size limit exceeded');
  const row = await op.sql.get<{ data: Uint8Array }>('SELECT data FROM inodes WHERE workspace_id=? AND id=?', op.workspace, node.id);
  if (!row) throw fsError('ENOENT', String(node.id));
  return new Uint8Array(row.data);
}
