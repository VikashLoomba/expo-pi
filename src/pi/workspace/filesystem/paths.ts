import { fsError } from './types';
import type { Inode, Location, Operation, WorkspaceLimits } from './types';

export function validatePath(path: string, limits: WorkspaceLimits): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || /(^|\/)\w[\w+.-]*:\/\//.test(path)) {
    throw fsError('EINVAL', String(path), 'invalid virtual path');
  }
  if (path.length > limits.maxPathLength) throw fsError('ENAMETOOLONG', path);
  // SQLite binds UTF-8 text. Reject lone UTF-16 surrogates rather than letting
  // replacement characters silently alias another directory entry/cache key.
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = path.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw fsError('EINVAL', path, 'invalid Unicode path');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw fsError('EINVAL', path, 'invalid Unicode path');
  }
  for (const part of path.split('/')) {
    if (new TextEncoder().encode(part).length > 255) throw fsError('ENAMETOOLONG', path);
  }
}
export function lexicalPath(base: string, path: string, limits: WorkspaceLimits): string {
  validatePath(base, limits); validatePath(path || '.', limits);
  const result: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${base}/${path}`).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') result.pop(); else result.push(part);
  }
  if (result.length > limits.maxDepth) throw fsError('ENAMETOOLONG', path, 'path depth limit exceeded');
  const value = `/${result.join('/')}`;
  validatePath(value, limits);
  return value;
}
export async function inode(op: Operation, id: number): Promise<Inode> {
  const row = await op.sql.get<Inode>('SELECT id,workspace_id,kind,mode,mtime,size,target FROM inodes WHERE workspace_id=? AND id=?', op.workspace, id);
  if (!row) throw fsError('ENOENT', String(id));
  return row;
}
/** Resolve components before handling .. so directory symlinks retain POSIX meaning. */
export async function resolve(op: Operation, path: string, followFinal = true, allowMissing = false): Promise<Location | { parent: number; name: string; path: string }> {
  validatePath(path, op.limits);
  let pending = path.split('/').filter(Boolean);
  const names: string[] = [];
  const stack = [await inode(op, op.root)];
  let symlinks = 0;
  let parent: number | undefined;
  let name: string | undefined;
  while (pending.length) {
    op.check();
    const part = pending.shift()!;
    const current = stack[stack.length - 1];
    if (current.kind !== 'directory') throw fsError('ENOTDIR', path);
    if (part === '.') continue;
    if (part === '..') { if (stack.length > 1) { stack.pop(); names.pop(); } continue; }
    const candidate = `/${[...names, part].join('/')}`;
    validatePath(candidate, op.limits);
    if (names.length >= op.limits.maxDepth) throw fsError('ENAMETOOLONG', path, 'path depth limit exceeded');
    const entry = await op.sql.get<{ inode: number }>('SELECT inode FROM entries WHERE workspace_id=? AND parent=? AND name=?', op.workspace, current.id, part);
    if (!entry) {
      if (allowMissing && !pending.length && !path.endsWith('/')) return { parent: current.id, name: part, path: candidate };
      throw fsError('ENOENT', path);
    }
    const next = await inode(op, entry.inode);
    if (next.kind === 'symlink' && (followFinal || pending.length > 0 || path.endsWith('/'))) {
      if (++symlinks > op.limits.maxSymlinks) throw fsError('ELOOP', path, 'too many symbolic links');
      let target = next.target!;
      validatePath(target, op.limits);
      if (op.mountPath !== '/') {
        if (target.startsWith('/')) {
          if (target !== op.mountPath && !target.startsWith(`${op.mountPath}/`)) throw fsError('EXDEV', target, 'cross-mount symbolic links are unsupported');
          target = target.slice(op.mountPath.length) || '/';
        } else {
          // MountableFs delegates resolution inside its child filesystem. It
          // cannot safely follow a relative link into a different mounted FS.
          let depth = names.length;
          for (const segment of target.split('/')) {
            if (segment === '..' && --depth < 0) throw fsError('EXDEV', target, 'symbolic link escapes workspace mount');
            if (segment && segment !== '.' && segment !== '..') depth++;
          }
        }
      }
      if (target.startsWith('/')) { stack.splice(1); names.length = 0; }
      // A trailing slash in the stored target is a directory requirement even
      // when the caller's original path has no trailing slash.
      pending = [...target.split('/').filter(Boolean), ...(target.endsWith('/') ? ['.'] : []), ...pending];
    } else {
      parent = current.id; name = part;
      names.push(part); stack.push(next);
    }
  }
  const result = stack[stack.length - 1];
  if (path.endsWith('/') && result.kind !== 'directory') throw fsError('ENOTDIR', path);
  // parent/name must describe the final stack, including a final .. component.
  if (stack.length > 1) { parent = stack[stack.length - 2].id; name = names[names.length - 1]; }
  else { parent = undefined; name = undefined; }
  return { inode: result, parent, name, path: `/${names.join('/')}` };
}
export async function existing(op: Operation, path: string, follow = true): Promise<Location> {
  return await resolve(op, path, follow) as Location;
}
export async function parentOf(op: Operation, path: string): Promise<{ parent: number; name: string }> {
  validatePath(path, op.limits);
  const parts = path.replace(/\/+$/, '').split('/');
  const name = parts.pop()!;
  if (!name || name === '.' || name === '..') throw fsError('EBUSY', path, 'cannot replace root or special directory entry');
  const parent = await existing(op, parts.join('/') || '/');
  if (parent.inode.kind !== 'directory') throw fsError('ENOTDIR', path);
  if (parent.path.split('/').filter(Boolean).length >= op.limits.maxDepth) throw fsError('ENAMETOOLONG', path);
  validatePath(`${parent.path === '/' ? '' : parent.path}/${name}`, op.limits);
  return { parent: parent.inode.id, name };
}
