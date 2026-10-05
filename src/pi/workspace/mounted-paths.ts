import type { IFileSystem } from 'just-bash/browser';

const MAX_PATH = 4096;
const MAX_DEPTH = 128;
const MAX_LINKS = 40;
const MAX_STEPS = 1024;
export type ResolveOptions = { followFinal?: boolean; missing?: boolean; missingDirectory?: boolean };

export function pathError(code: string, path: string) {
  return Object.assign(new Error(`${code}: invalid virtual filesystem path '${path}'`), { code });
}

export function validateVirtualPath(path: string): void {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || /(^|\/)\w[\w+.-]*:\/\//.test(path)) {
    throw pathError('EINVAL', String(path));
  }
  if (path.length > MAX_PATH) throw pathError('ENAMETOOLONG', path);
}

/** Join without erasing `link/..`; only the async physical resolver may do that. */
export function joinVirtualPath(base: string, path: string): string {
  validateVirtualPath(base); validateVirtualPath(path || '.');
  const result = path.startsWith('/') ? path : `${base.replace(/\/$/, '')}/${path || '.'}`;
  validateVirtualPath(result);
  return result.startsWith('/') ? result : `/${result}`;
}

/** Resolve physical components before MountableFs can erase symlink/.. semantics. */
export function createPathResolver(delegate: IFileSystem, signal?: AbortSignal) {
  function live<T>(operation: () => T): T { signal?.throwIfAborted(); return operation(); }
  async function physical(path: string, options: ResolveOptions = {}): Promise<string> {
    signal?.throwIfAborted();
    validateVirtualPath(path);
    const pending = path.split('/').filter(Boolean);
    const resolved: string[] = [];
    let links = 0;
    let steps = 0;
    let directory = true;
    while (pending.length) {
      signal?.throwIfAborted();
      if (++steps > MAX_STEPS) throw pathError('ELOOP', path);
      if (!directory) throw pathError('ENOTDIR', path);
      const component = pending.shift()!;
      if (component === '.') continue;
      if (component === '..') { resolved.pop(); continue; }
      const candidate = `/${[...resolved, component].join('/')}`;
      validateVirtualPath(candidate);
      if (resolved.length >= MAX_DEPTH) throw pathError('ENAMETOOLONG', path);
      let stat;
      try { stat = await delegate.lstat(candidate); }
      catch (cause) {
        signal?.throwIfAborted();
        // InMemoryFs uses message-only errors; SQLite also supplies `.code`.
        const missing = (cause as { code?: string }).code === 'ENOENT' || /^ENOENT\b/.test(String((cause as Error).message));
        if (!missing || !(options.missing && !pending.length)) throw cause;
        resolved.push(component);
        directory = options.missingDirectory || false;
        continue;
      }
      if (stat.isSymbolicLink && (options.followFinal !== false || pending.length)) {
        if (++links > MAX_LINKS) throw pathError('ELOOP', path);
        const target = await live(() => delegate.readlink(candidate));
        validateVirtualPath(target);
        if (target.startsWith('/')) resolved.length = 0;
        const targetParts = target.split('/').filter(Boolean);
        if (target.endsWith('/')) targetParts.push('.');
        pending.unshift(...targetParts);
        continue;
      }
      resolved.push(component);
      directory = stat.isDirectory;
    }
    signal?.throwIfAborted();
    if (path.endsWith('/') && !directory) throw pathError('ENOTDIR', path);
    const result = `/${resolved.join('/')}`;
    return path.endsWith('/') && result !== '/' ? `${result}/` : result;
  }

  return { physical, live };
}
