import type { FsStat } from 'just-bash';
import { existing, resolve } from './paths';
import { addEntry, bytesFor, capacity, newInode } from './records';
import { fsError } from './types';
import type { Inode, Operation } from './types';

export function statFor(node: Inode): FsStat {
  return { isFile: node.kind === 'file', isDirectory: node.kind === 'directory', isSymbolicLink: node.kind === 'symlink',
    mode: node.mode, size: node.size, mtime: new Date(node.mtime), ino: node.id, identity: `${node.workspace_id}:${node.id}` };
}
export async function write(op: Operation, path: string, bytes: Uint8Array, append: boolean): Promise<void> {
  const location = await resolve(op, path, true, true);
  if (!('inode' in location)) {
    const node = await newInode(op, 'file', 0o644, bytes);
    await addEntry(op, location.parent, location.name, node.id);
    return;
  }
  const node = location.inode;
  if (node.kind !== 'file') throw fsError('EISDIR', path);
  const size = bytes.length + (append ? node.size : 0);
  if (size > op.limits.maxFileBytes) throw fsError('EFBIG', path, 'file size limit exceeded');
  await capacity(op, size - node.size);
  let output = bytes;
  if (append && node.size) {
    output = new Uint8Array(size);
    output.set(await bytesFor(op, node)); output.set(bytes, node.size);
  }
  await op.sql.run('UPDATE inodes SET data=CASE WHEN ?=0 THEN zeroblob(0) ELSE ? END,size=?,mtime=? WHERE workspace_id=? AND id=?', size, output, size, Date.now(), op.workspace, node.id);
}
export async function metadata(op: Operation, path: string, mode?: number, mtime?: Date): Promise<void> {
  const node = (await existing(op, path)).inode;
  if (mode !== undefined) {
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) throw fsError('EINVAL', path, 'invalid permission bits');
    await op.sql.run('UPDATE inodes SET mode=? WHERE workspace_id=? AND id=?', mode, op.workspace, node.id);
  }
  if (mtime !== undefined) {
    if (!Number.isFinite(mtime.getTime())) throw fsError('EINVAL', path, 'invalid timestamp');
    await op.sql.run('UPDATE inodes SET mtime=? WHERE workspace_id=? AND id=?', mtime.getTime(), op.workspace, node.id);
  }
}
