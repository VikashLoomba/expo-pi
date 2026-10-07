import { Bash, type CommandName, type IFileSystem } from 'just-bash/browser';

import { BASH_EXECUTION_LIMITS } from './limits';

export { BASH_EXECUTION_LIMITS } from './limits';

// An explicit list makes package upgrades a capabilities review. Browser-only
// file detection needs DecompressionStream; HTML conversion needs a DOM parser.
// Neither is advertised on Hermes. The other omissions are upstream's browser
// exclusions, native processes, networking, and optional language runtimes.
export const BASH_CAPABILITIES = Object.freeze([
  'echo', 'cat', 'printf', 'ls', 'mkdir', 'mktemp', 'rmdir', 'touch', 'rm', 'cp', 'mv',
  'ln', 'chmod', 'pwd', 'readlink', 'head', 'tail', 'wc', 'stat', 'grep', 'fgrep',
  'egrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'comm', 'cut', 'paste', 'tr', 'rev',
  'nl', 'fold', 'expand', 'unexpand', 'strings', 'split', 'column', 'join', 'tee',
  'find', 'basename', 'dirname', 'tree', 'du', 'env', 'printenv', 'alias', 'unalias',
  'history', 'xargs', 'true', 'false', 'yes', 'clear', 'bash', 'sh', 'jq', 'base64',
  'diff', 'date', 'sleep', 'timeout', 'seq', 'expr', 'md5sum', 'sha1sum', 'sha256sum',
  'help', 'which', 'tac', 'hostname', 'od', 'gzip', 'gunzip', 'zcat', 'time', 'whoami',
] satisfies CommandName[]);

export const BASH_CAPABILITY_DESCRIPTION =
  'An interpreted local shell with pipes, redirects, loops, scripts, text processing, jq, ' +
  'checksums, gzip/gunzip/zcat and rg (including gzip search). ' +
  'No native programs, network commands, JS, Python, sqlite3, tar, yq, xan, file, or html-to-markdown. ' +
  '/workspace persists across restarts; system directories and /tmp are shared until the chat service closes (4 MiB, 1024 entries). ' +
  'Each call starts in the selected conversation cwd (default /workspace) with fresh shell variables/functions. ' +
  'Commands have a requested cooperative deadline of at most 30 seconds, a 64 KiB source limit and 4 MiB output limit. ' +
  'Compression accepts at most 4 MiB input/output and 128 gzip members. ' +
  `Available commands: ${BASH_CAPABILITIES.join(', ')}.`;

/**
 * Own one instance per invocation: exec restores its environment/cwd and does
 * not promise a persistent interactive process. The caller supplies a mounted
 * virtual filesystem and owns serialization, cancellation and durable storage.
 */
export function createBashEngine(fs: IFileSystem, timeoutMs = BASH_EXECUTION_LIMITS.maxExecutionTimeMs): Bash {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BASH_EXECUTION_LIMITS.maxExecutionTimeMs) {
    throw new RangeError('Shell timeout must be an integer between 1 and 30000 milliseconds');
  }
  return new Bash({
    fs,
    cwd: '/workspace',
    env: { HOME: '/workspace', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
    commands: [...BASH_CAPABILITIES],
    python: false,
    javascript: false,
    defenseInDepth: false,
    executionLimitProfile: 'hardened',
    executionLimits: { ...BASH_EXECUTION_LIMITS, maxExecutionTimeMs: timeoutMs },
  });
}
