import type { CpOptions, CreateExclusiveOptions, MkdirOptions, RmOptions } from 'just-bash';
import { existing, inode, parentOf, resolve, validatePath } from './paths';
import { addEntry, bytesFor, children, newInode, removeEntry, touchParent } from './records';
import { write } from './content';
import { entryKey, fsError } from './types';
import type { Location, Operation } from './types';

export async function createExclusive(op: Operation, path: string, options: CreateExclusiveOptions): Promise<void> {
  if (!Number.isInteger(options.mode) || options.mode < 0 || options.mode > 0o7777) throw fsError('EINVAL', path, 'invalid mode');
  if (!options.directory && path.endsWith('/')) throw fsError('EISDIR', path);
  const { parent, name } = await parentOf(op, path);
  if (await op.sql.get('SELECT 1 FROM entries WHERE workspace_id=? AND parent=? AND name=?', op.workspace, parent, name)) throw fsError('EEXIST', path);
  const node = await newInode(op, options.directory ? 'directory' : 'file', options.mode);
  await addEntry(op, parent, name, node.id);
}
export async function mkdir(op: Operation, path: string, options?: MkdirOptions): Promise<void> {
  validatePath(path, op.limits);
  if (!options?.recursive) return createExclusive(op, path, { mode: 0o755, directory: true });
  let prefix = '';
  for (const part of path.split('/').filter(Boolean)) {
    prefix += `/${part}`;
    try {
      const node = (await existing(op, prefix)).inode;
      if (node.kind !== 'directory') throw fsError('ENOTDIR', prefix);
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error;
      await createExclusive(op, prefix, { mode: 0o755, directory: true });
    }
  }
}
export async function link(op: Operation, target: string, path: string, symbolic: boolean): Promise<void> {
  const { parent, name } = await parentOf(op, path);
  if (await op.sql.get('SELECT 1 FROM entries WHERE workspace_id=? AND parent=? AND name=?', op.workspace, parent, name)) throw fsError('EEXIST', path);
  let id: number;
  if (symbolic) {
    validatePath(target, op.limits);
    id = (await newInode(op, 'symlink', 0o777, undefined, target)).id;
  } else {
    const node = (await existing(op, target, false)).inode;
    if (node.kind === 'directory') throw fsError('EPERM', target, 'hard links to directories are prohibited');
    id = node.id;
  }
  await addEntry(op, parent, name, id);
}
async function removeLocation(op: Operation, location: Location, recursive: boolean): Promise<void> {
  if (location.parent === undefined || location.name === undefined) throw fsError('EBUSY', location.path, 'cannot remove workspace root');
  if (location.inode.kind === 'directory') {
    const list = await children(op, location.inode.id);
    if (list.length && !recursive) throw fsError('ENOTEMPTY', location.path);
    for (const child of list) {
      await removeLocation(op, { inode: await inode(op, child.inode), parent: child.parent, name: child.name, path: `${location.path}/${child.name}` }, true);
    }
  }
  await removeEntry(op, location.parent, location.name, location.inode.id);
}
export async function rm(op: Operation, path: string, options?: RmOptions): Promise<void> {
  let location: Location;
  try { location = await existing(op, path.replace(/\/+$/, '') || '/', false); }
  catch (error) {
    if (options?.force && (error as { code?: string } | null)?.code === 'ENOENT') return;
    throw error;
  }
  if (path.endsWith('/') && location.inode.kind !== 'directory') throw fsError('ENOTDIR', path);
  await removeLocation(op, location, options?.recursive ?? false);
}
async function rejectDescendant(op: Operation, source: number, parent: number): Promise<void> {
  let current = parent;
  for (let depth = 0; depth <= op.limits.maxDepth; depth++) {
    if (current === source) throw fsError('EINVAL', '', 'cannot put directory inside itself');
    if (current === op.root) return;
    const next = await op.sql.get<{ parent: number }>('SELECT parent FROM entries WHERE workspace_id=? AND inode=?', op.workspace, current);
    if (!next) throw fsError('ENOENT', String(current));
    current = next.parent;
  }
  throw fsError('ELOOP', '', 'directory ancestry limit exceeded');
}
async function assertTreeFits(op: Operation, source: number, destination: string): Promise<void> {
  const pending = [{ id: source, path: destination }];
  while (pending.length) {
    op.check();
    const current = pending.pop()!;
    validatePath(current.path, op.limits);
    if (current.path.split('/').filter(Boolean).length > op.limits.maxDepth) throw fsError('ENAMETOOLONG', destination, 'moved subtree exceeds depth limit');
    for (const child of await children(op, current.id)) pending.push({ id: child.inode, path: `${current.path}/${child.name}` });
  }
}
export async function mv(op: Operation, source: string, destination: string): Promise<void> {
  const from = await existing(op, source.replace(/\/+$/, '') || '/', false);
  if ((source.endsWith('/') || destination.endsWith('/')) && from.inode.kind !== 'directory') throw fsError('ENOTDIR', source);
  if (from.parent === undefined || from.name === undefined) throw fsError('EBUSY', source);
  const to = await parentOf(op, destination);
  if (from.parent === to.parent && from.name === to.name) return;
  if (from.inode.kind === 'directory') {
    await rejectDescendant(op, from.inode.id, to.parent);
    const canonical = await resolve(op, destination.replace(/\/+$/, '') || '/', false, true);
    await assertTreeFits(op, from.inode.id, canonical.path);
  }
  const entry = await op.sql.get<{ inode: number }>('SELECT inode FROM entries WHERE workspace_id=? AND parent=? AND name=?', op.workspace, to.parent, to.name);
  if (entry) {
    if (entry.inode === from.inode.id) return;
    const target = await inode(op, entry.inode);
    if (from.inode.kind === 'directory' && target.kind !== 'directory') throw fsError('ENOTDIR', destination);
    if (from.inode.kind !== 'directory' && target.kind === 'directory') throw fsError('EISDIR', destination);
    await removeLocation(op, { inode: target, ...to, path: destination }, false);
  }
  await op.sql.run('UPDATE entries SET parent=?,name=? WHERE workspace_id=? AND parent=? AND name=?', to.parent, to.name, op.workspace, from.parent, from.name);
  const oldParent = from.parent, oldName = from.name;
  op.changes.push((cache) => {
    cache.entries.delete(entryKey(oldParent, oldName));
    cache.entries.set(entryKey(to.parent, to.name), { ...to, inode: from.inode.id });
  });
  await touchParent(op, from.parent); await touchParent(op, to.parent);
}
export async function cp(op: Operation, source: string, destination: string, options?: CpOptions): Promise<void> {
  const from = await existing(op, source, false);
  const to = await parentOf(op, destination);
  if (from.inode.kind === 'directory') {
    if (!options?.recursive) throw fsError('EISDIR', source);
    await rejectDescendant(op, from.inode.id, to.parent);
    let target: Location;
    try { target = await existing(op, destination); }
    catch (error) {
      if ((error as { code?: string } | null)?.code !== 'ENOENT') throw error;
      await createExclusive(op, destination, { mode: from.inode.mode, directory: true });
      target = await existing(op, destination);
    }
    if (target.inode.kind !== 'directory') throw fsError('ENOTDIR', destination);
    await rejectDescendant(op, from.inode.id, target.inode.id);
    const list = await children(op, from.inode.id);
    for (const child of list) await cp(op, `${source.replace(/\/$/, '')}/${child.name}`, `${destination.replace(/\/$/, '')}/${child.name}`, options);
    await op.sql.run('UPDATE inodes SET mtime=? WHERE workspace_id=? AND id=?', from.inode.mtime, op.workspace, target.inode.id);
  } else if (from.inode.kind === 'symlink') {
    const previous = await resolve(op, destination, false, true);
    if ('inode' in previous) {
      if (previous.inode.kind === 'directory') throw fsError('EISDIR', destination);
      if (previous.inode.id === from.inode.id) throw fsError('EINVAL', destination, 'same file');
      await removeLocation(op, previous, false);
    }
    const node = await newInode(op, 'symlink', from.inode.mode, undefined, from.inode.target!, from.inode.mtime);
    await addEntry(op, to.parent, to.name, node.id);
  } else {
    const target = await resolve(op, destination, true, true);
    if ('inode' in target && target.inode.id === from.inode.id) throw fsError('EINVAL', destination, 'same file');
    const bytes = await bytesFor(op, from.inode);
    await write(op, destination, bytes, false);
    const copied = await existing(op, destination);
    await op.sql.run('UPDATE inodes SET mode=?,mtime=? WHERE workspace_id=? AND id=?', from.inode.mode, from.inode.mtime, op.workspace, copied.inode.id);
  }
}
