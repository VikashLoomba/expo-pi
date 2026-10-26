import { FileError } from '@earendil-works/pi-durable/env';

/** POSIX path rules of the supported remote hosts; never the phone's filesystem. */
function normalize(path: string): string {
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (part !== '..' || !absolute) parts.push(part);
  }
  const result = `${absolute ? '/' : ''}${parts.join('/')}` || '.';
  return trailing && result !== '/' ? `${result}/` : result;
}

export const posix = {
  join: (...parts: string[]) => normalize(parts.filter(Boolean).join('/')),
  resolve: (...parts: string[]) => {
    let path = '';
    for (const part of [...parts].reverse()) {
      path = `${part}/${path}`;
      if (part.startsWith('/')) break;
    }
    const result = normalize(path);
    return result === '/' ? result : result.replace(/\/$/, '');
  },
  basename: (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? '',
};
export type PlatformPath = typeof posix;

export function resolveRemotePath(cwd: string, path: string, home?: string): string {
  if (!cwd.startsWith('/')) {
    throw new FileError('not_supported', 'Remote working directories must use an absolute POSIX path.', cwd);
  }
  let normalized = path;
  if (path === '~' || path.startsWith('~/')) {
    if (home === undefined) throw new FileError('invalid', 'Remote home directory is unavailable.', path);
    normalized = path === '~' ? home : posix.join(home, path.slice(2));
  } else if (path.startsWith('file://')) {
    try {
      const url = new URL(path);
      if (url.protocol !== 'file:' || (url.hostname !== '' && url.hostname !== 'localhost') || /%2f/i.test(url.pathname)) {
        throw new Error('Invalid file URL');
      }
      normalized = decodeURIComponent(url.pathname);
    } catch {
      // Pi treats malformed file URLs as ordinary relative paths.
    }
  }
  return posix.resolve(cwd, normalized);
}
