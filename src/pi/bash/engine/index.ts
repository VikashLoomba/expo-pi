import { Bash, type CommandName, type IFileSystem } from 'just-bash/browser';

// An explicit list makes package upgrades a capabilities review. Browser-only
// file detection needs DecompressionStream; HTML conversion needs a DOM parser;
// gzip needs node:zlib and sha1sum/sha256sum need crypto.subtle, which Hermes
// lacks; the workspace has no links or permission bits for ln, readlink or
// chmod. None is advertised on device. The
// other omissions are upstream's browser exclusions, native processes,
// networking, and optional language runtimes.
export const BASH_CAPABILITIES = Object.freeze([
  'echo', 'cat', 'printf', 'ls', 'mkdir', 'mktemp', 'rmdir', 'touch', 'rm', 'cp', 'mv',
  'pwd', 'head', 'tail', 'wc', 'stat', 'grep', 'fgrep',
  'egrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'comm', 'cut', 'paste', 'tr', 'rev',
  'nl', 'fold', 'expand', 'unexpand', 'strings', 'split', 'column', 'join', 'tee',
  'find', 'basename', 'dirname', 'tree', 'du', 'env', 'printenv', 'alias', 'unalias',
  'history', 'xargs', 'true', 'false', 'yes', 'clear', 'bash', 'sh', 'jq', 'base64',
  'diff', 'date', 'sleep', 'timeout', 'seq', 'expr', 'md5sum',
  'help', 'which', 'tac', 'hostname', 'od', 'time', 'whoami',
] satisfies CommandName[]);

export function isBashCommand(name: string | undefined): boolean {
  return BASH_CAPABILITIES.some((command) => command === name);
}

export const BASH_CAPABILITY_DESCRIPTION =
  'An interpreted local shell with pipes, redirects, loops, scripts, text processing, jq, md5sum and rg. ' +
  'No native programs, network commands, JS, Python, sqlite3, tar, gzip, sha1sum, sha256sum, yq, xan, file, ' +
  'or html-to-markdown. ' +
  '/workspace persists across restarts; it has no symbolic links, hard links or permission bits. ' +
  '/tmp starts empty for every command. ' +
  'Each call starts in the selected conversation cwd (default /workspace) with fresh shell variables/functions. ' +
  `Available commands: ${BASH_CAPABILITIES.join(', ')}.`;

/**
 * Own one instance per command: exec restores its environment/cwd and does not
 * promise a persistent interactive process. The caller supplies the filesystem
 * and owns cancellation. Limits are just-bash's defaults.
 */
export function createBashEngine(fs: IFileSystem): Bash {
  return new Bash({
    fs,
    cwd: '/workspace',
    env: { HOME: '/workspace', TMPDIR: '/tmp', LANG: 'C.UTF-8' },
    commands: [...BASH_CAPABILITIES],
  });
}
