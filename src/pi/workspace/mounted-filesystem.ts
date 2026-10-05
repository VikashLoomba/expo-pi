import { MountableFs } from 'just-bash/browser';
import type { IFileSystem } from 'just-bash/browser';
import { createPathResolver, joinVirtualPath as join, pathError as error, validateVirtualPath as validate } from './mounted-paths';
import type { ResolveOptions } from './mounted-paths';

/**
 * MountableFs routes a lexically normalized path and forwards absolute symlink
 * targets unchanged. Resolve in the complete virtual namespace first, so links
 * can refer to /workspace or the temporary system tree without escaping either.
 * The delegate only receives paths without intermediate symlinks or dot segments.
 */
export function createMountedFileSystem(base: IFileSystem, workspace: IFileSystem, signal?: AbortSignal): IFileSystem & Pick<MountableFs, 'mkdirSync' | 'writeFileSync'> {
  const delegate = new MountableFs({ base, mounts: [{ mountPoint: '/workspace', filesystem: workspace }] });
  const { physical, live } = createPathResolver(delegate, signal);
  const preserve = { followFinal: false };
  const destination = { followFinal: false, missing: true };
  async function at<T>(path: string, options: ResolveOptions, operation: (resolved: string) => Promise<T>): Promise<T> {
    const resolved = await physical(path, options);
    return live(() => operation(resolved));
  }
  function owner(path: string) {
    const mount = delegate.getMounts().find(({ mountPoint }) => path === mountPoint || path.startsWith(`${mountPoint}/`));
    return mount ? { fs: mount.filesystem, path: path.slice(mount.mountPoint.length) || '/' } : { fs: base, path };
  }
  async function copy(source: string, target: string, recursive: boolean, budget = { entries: 0 }): Promise<void> {
    signal?.throwIfAborted();
    if (++budget.entries > 4096) throw error('ELOOP', source);
    const stat = await live(() => delegate.lstat(source));
    target = await physical(target, { followFinal: !stat.isSymbolicLink, missing: true, missingDirectory: stat.isDirectory });
    if (source === target || (stat.isDirectory && target.startsWith(`${source.replace(/\/$/, '')}/`))) throw error('EINVAL', target);
    const from = owner(source), to = owner(target);
    // Bypass MountableFs's following stat(src) for same-mount dangling links.
    if (from.fs === to.fs) return live(() => from.fs.cp(from.path, to.path, { recursive }));
    if (stat.isSymbolicLink) {
      if (source === target) throw error('EINVAL', target);
      let previous;
      try { previous = await delegate.lstat(target); }
      catch (cause) { signal?.throwIfAborted(); if (!/^ENOENT\b/.test(String((cause as Error).message))) throw cause; }
      if (previous?.isDirectory) throw error('EISDIR', target);
      if (previous && previous.identity && previous.identity === stat.identity) throw error('EINVAL', target);
      if (previous) await live(() => delegate.rm(target));
      const link = await live(() => delegate.readlink(source));
      await live(() => delegate.symlink(link, target));
    } else if (stat.isDirectory) {
      if (!recursive) throw error('EISDIR', source);
      await live(() => delegate.mkdir(target, { recursive: true }));
      for (const name of await live(() => delegate.readdir(source))) await copy(`${source}/${name}`, `${target}/${name}`, true, budget);
      await live(() => delegate.chmod(target, stat.mode));
      await live(() => delegate.utimes(target, stat.mtime, stat.mtime));
    } else {
      const bytes = await live(() => delegate.readFileBuffer(source));
      await live(() => delegate.writeFile(target, bytes));
      await live(() => delegate.chmod(target, stat.mode));
      await live(() => delegate.utimes(target, stat.mtime, stat.mtime));
    }
  }
  // Only Bash's constructor uses these methods, with generated canonical paths.
  // Guest commands use async methods so symlink resolution and aborts are honored.
  function initializationPath(path: string): void {
    validate(path);
    if (!/^\/(bin|usr\/bin|dev|proc)(\/[A-Za-z0-9._-]+)*$/.test(path)
      || path.split('/').some((part) => part === '.' || part === '..')) throw error('ENOSYS', path);
  }
  return {
    mkdirSync: (path, options) => live(() => { initializationPath(path); delegate.mkdirSync(path, options); }),
    writeFileSync: (path, content) => live(() => { initializationPath(path); delegate.writeFileSync(path, content); }),
    resolvePath: (base, path) => live(() => join(base, path)),
    getAllPaths: () => live(() => delegate.getAllPaths()),
    readFile: (path, options) => at(path, {}, (resolved) => delegate.readFile(resolved, options)),
    readFileBuffer: (path) => at(path, {}, (resolved) => delegate.readFileBuffer(resolved)),
    readFileBytes: async (path) => {
      const resolved = await physical(path);
      // MountableFs in the pinned release implements this optional capability.
      return live(() => delegate.readFileBytes!(resolved));
    },
    writeFile: (path, content, options) => at(path, { missing: true }, (resolved) => delegate.writeFile(resolved, content, options)),
    appendFile: (path, content, options) => at(path, { missing: true }, (resolved) => delegate.appendFile(resolved, content, options)),
    exists: async (path) => {
      try { await physical(path); return true; }
      catch (cause) {
        signal?.throwIfAborted();
        const code = (cause as { code?: string }).code;
        if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? '') || /^(ENOENT|ENOTDIR|ELOOP)\b/.test(String((cause as Error).message))) return false;
        throw cause;
      }
    },
    stat: (path) => at(path, {}, (resolved) => delegate.stat(resolved)),
    lstat: (path) => at(path, path.endsWith('/') ? {} : preserve, (resolved) => delegate.lstat(resolved)),
    realpath: async (path) => (await physical(path)).replace(/\/$/, '') || '/',
    readlink: (path) => at(path, preserve, (resolved) => delegate.readlink(resolved)),
    readdir: (path) => at(path, {}, (resolved) => delegate.readdir(resolved)),
    readdirWithFileTypes: async (path) => {
      const resolved = await physical(path);
      const owned = owner(resolved);
      if (resolved !== '/' && owned.fs.readdirWithFileTypes) return live(() => owned.fs.readdirWithFileTypes!(owned.path));
      const names = await live(() => delegate.readdir(resolved));
      if (names.length > 4096) throw error('ELOOP', path);
      const result = [];
      for (const name of names) {
        const stat = await live(() => delegate.lstat(join(resolved, name)));
        result.push({ name, isFile: stat.isFile, isDirectory: stat.isDirectory, isSymbolicLink: stat.isSymbolicLink });
      }
      return result;
    },
    mkdir: async (path, options) => {
      signal?.throwIfAborted();
      if (!options?.recursive) return at(path, { ...destination, missingDirectory: true }, (resolved) => delegate.mkdir(resolved));
      validate(path);
      const parts = path.split('/').filter(Boolean);
      if (parts.length > 1024) throw error('ELOOP', path);
      let current = '/';
      // Create each missing prefix before processing ..; normalizing the whole
      // path first would lose mkdir -p a/../b's creation of a.
      for (const part of parts) {
        const candidate = join(current, part);
        const resolved = await physical(candidate, { ...destination, missingDirectory: true });
        let stat;
        try { stat = await live(() => delegate.lstat(resolved)); }
        catch (cause) {
          signal?.throwIfAborted();
          if (!/^ENOENT\b/.test(String((cause as Error).message))) throw cause;
        }
        if (!stat) await live(() => delegate.mkdir(resolved));
        else if (stat.isSymbolicLink) {
          try { current = await physical(candidate); }
          catch (cause) {
            signal?.throwIfAborted();
            if (/^ENOENT\b/.test(String((cause as Error).message))) throw error('EEXIST', candidate);
            throw cause;
          }
          if (!(await live(() => delegate.stat(current))).isDirectory) throw error('ENOTDIR', candidate);
          continue;
        } else if (!stat.isDirectory) throw error('ENOTDIR', candidate);
        current = resolved;
      }
    },
    createExclusive: (path, options) => at(path, {
      ...destination, missingDirectory: options.directory,
    }, (resolved) => delegate.createExclusive(resolved, options)),
    rm: async (path, options) => {
      try { await at(path, preserve, (resolved) => delegate.rm(resolved, options)); }
      catch (cause) {
        signal?.throwIfAborted();
        const missing = (cause as { code?: string }).code === 'ENOENT' || /^ENOENT\b/.test(String((cause as Error).message));
        if (!options?.force || !missing) throw cause;
      }
    },
    mv: async (source, target) => {
      const from = await physical(source, preserve);
      const sourceStat = await live(() => delegate.lstat(from));
      const to = await physical(target, { ...destination, missingDirectory: sourceStat.isDirectory });
      if (from === '/' || to === '/' || delegate.isMountPoint(from) || delegate.isMountPoint(to)) throw error('EBUSY', source);
      if (from === to) return;
      let previous;
      try { previous = await live(() => delegate.lstat(to)); }
      catch (cause) {
        signal?.throwIfAborted();
        if (!/^ENOENT\b/.test(String((cause as Error).message))) throw cause;
      }
      if (previous) {
        if (sourceStat.isDirectory && !previous.isDirectory) throw error('ENOTDIR', target);
        if (!sourceStat.isDirectory && previous.isDirectory) throw error('EISDIR', target);
        if (previous.isDirectory && (await live(() => delegate.readdir(to))).length) throw error('ENOTEMPTY', target);
      }
      const sourceOwner = owner(from), targetOwner = owner(to);
      if (sourceOwner.fs === targetOwner.fs) return live(() => sourceOwner.fs.mv(sourceOwner.path, targetOwner.path));
      // Cross-mount move is copy then delete, with ordinary shell partial success:
      // an interrupted copy may leave a partial destination and retains its source.
      // Remove the final entry first so links are replaced rather than written through.
      if (previous) await live(() => targetOwner.fs.rm(targetOwner.path));
      await copy(from, to, true);
      return live(() => sourceOwner.fs.rm(sourceOwner.path, { recursive: true }));
    },
    cp: async (source, target, options) => {
      const from = await physical(source, preserve);
      const sourceStat = await delegate.lstat(from);
      const to = await physical(target, { followFinal: !sourceStat.isSymbolicLink, missing: true, missingDirectory: sourceStat.isDirectory });
      return copy(from, to, options?.recursive ?? false);
    },
    chmod: (path, mode) => at(path, {}, (resolved) => delegate.chmod(resolved, mode)),
    utimes: (path, atime, mtime) => at(path, {}, (resolved) => delegate.utimes(resolved, atime, mtime)),
    symlink: async (target, path) => {
      validate(target);
      return at(path, destination, (resolved) => delegate.symlink(target, resolved));
    },
    link: async (target, path) => {
      const from = await physical(target, preserve);
      return at(path, destination, (resolved) => delegate.link(from, resolved));
    },
  };
}
