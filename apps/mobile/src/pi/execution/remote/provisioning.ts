import type { SshConnection } from '@automatalabs/react-native-ssh';
import { loadPackagedDaemon, type DaemonPlatform } from './daemon-assets';
import { BootstrapError } from './bootstrap-errors';
import { runSshCommand } from './command-channel';

export type SshSetupStage = 'detecting' | 'checking' | 'uploading';

/** An authenticated SSH account's POSIX home and matching packaged target. */
export type RemotePlatform = DaemonPlatform & { home: string };
/** What a connection learned about its remote system, kept across its starts like pi-env's `SshState`. */
export interface RemotePlatformState { remote?: RemotePlatform }

export function quotePosix(value: string): string { return `'${value.replace(/'/g, `'"'"'`)}'`; }

const HASH = `hash() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | sed 's/.*= //'; else printf 'none\\n'; fi; }`;

function script(source: string): string { return `sh -c ${quotePosix(source)}`; }

function afterMarker(stdout: string, marker: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const start = lines.lastIndexOf(marker);
  if (start < 0) throw new BootstrapError('DAEMON_SETUP');
  return lines.slice(start + 1);
}

async function detect(connection: SshConnection, signal: AbortSignal, token: string): Promise<RemotePlatform> {
  const marker = `PI-ENV-PROBE ${token}`;
  const response = await runSshCommand(connection, script(`set -eu\nprintf '%s\\n' ${quotePosix(marker)}\nif [ "$(uname -o 2>/dev/null || true)" = Android ]; then printf '%s\\n' Android; else uname -s; fi\nuname -m\nprintf '%s\\n' "$HOME"`), { signal });
  if (response.exitCode !== 0) throw new BootstrapError('UNSUPPORTED_REMOTE');
  const [system, machine, home, ...trailing] = afterMarker(response.stdout, marker);
  const platform = system === 'Darwin' ? 'darwin' : system === 'Linux' ? 'linux' : undefined;
  const arch = machine === 'arm64' || machine === 'aarch64' ? 'arm64'
    : machine === 'x86_64' || machine === 'amd64' || machine === 'x64' ? 'x64' : undefined;
  if (!platform || !arch) throw new BootstrapError('UNSUPPORTED_REMOTE');
  if (!home?.startsWith('/') || /[\x00-\x1f\x7f]/.test(home) || trailing.length !== 1 || trailing[0] !== '') {
    throw new BootstrapError('DAEMON_SETUP');
  }
  return { platform, arch, home: home.replace(/\/+$/, '') || '/' };
}

/**
 * Detect the remote system at a connection's first start, as pi-env's `sshConnection` does, and verify the daemon on
 * every start. Upload the packaged binary only when missing or corrupt, then publish by atomic rename. Unique
 * temporary files permit concurrent clients; each client cleans only its own temporary file, never another version
 * or upload.
 */
export async function provisionDaemon(connection: SshConnection, options: {
  signal: AbortSignal;
  token: string;
  platform: RemotePlatformState;
  onProgress?: (stage: SshSetupStage) => void;
}): Promise<string> {
  const { signal, token, platform } = options;
  if (!/^[a-f0-9]{32}$/.test(token)) throw new BootstrapError('DAEMON_SETUP');
  if (signal.aborted) throw new BootstrapError('CANCELLED');
  if (!platform.remote) {
    options.onProgress?.('detecting');
    platform.remote = await detect(connection, signal, token);
  }
  const remote = platform.remote;
  const binary = await loadPackagedDaemon({ platform: remote.platform, arch: remote.arch }, signal);
  if (signal.aborted) throw new BootstrapError('CANCELLED');
  const file = `${remote.home === '/' ? '' : remote.home}/.pi/mobile/tools/pi-env-${binary.sha256.slice(0, 32)}`;
  const cacheMarker = `PI-ENV-CACHE ${token}`;
  options.onProgress?.('checking');
  const checked = await runSshCommand(connection, script([
    'set -eu', HASH, `f=${quotePosix(file)}`,
    `if [ "$(hash /dev/null)" = none ]; then printf '%s\\n' ${quotePosix(`${cacheMarker} nohash`)}`,
    `elif [ -f "$f" ] && [ ! -L "$f" ] && [ -x "$f" ] && [ "$(hash "$f")" = ${binary.sha256} ]; then printf '%s\\n' ${quotePosix(`${cacheMarker} present`)}`,
    `else printf '%s\\n' ${quotePosix(`${cacheMarker} missing`)}; fi`,
  ].join('\n')), { signal });
  if (checked.exitCode !== 0) throw new BootstrapError('DAEMON_SETUP');
  const state = checked.stdout.trimEnd().split(/\r?\n/).at(-1);
  if (state === `${cacheMarker} present`) return file;
  if (state === `${cacheMarker} nohash`) throw new BootstrapError('DAEMON_VERIFY');
  if (state !== `${cacheMarker} missing`) throw new BootstrapError('DAEMON_SETUP');
  options.onProgress?.('uploading');
  const uploadMarker = `PI-ENV-UPLOAD ${token} verified`;
  const uploaded = await runSshCommand(connection, script([
    'set -eu', HASH, `f=${quotePosix(file)}`, 'd=$(dirname "$f")', 'umask 077',
    'mkdir -p "$d"', 'chmod 700 "$d"', 't=$(mktemp "$d/.pi-env.XXXXXX")',
    `trap 'rm -f "$t"' 0`, `trap 'exit 1' HUP INT TERM`,
    // mv on POSIX treats a directory (including a symlink to one) as a
    // container. Never publish into that unrelated location.
    'if [ -L "$f" ] || { [ -e "$f" ] && [ ! -f "$f" ]; }; then exit 1; fi',
    'cat > "$t"', `if [ "$(hash "$t")" != ${binary.sha256} ]; then exit 1; fi`,
    'chmod 700 "$t"', 'mv -f "$t" "$f"',
    `[ -f "$f" ] && [ ! -L "$f" ] && [ -x "$f" ] && [ "$(hash "$f")" = ${binary.sha256} ]`,
    `printf '%s\\n' ${quotePosix(uploadMarker)}`,
  ].join('\n')), { signal, input: binary.bytes, timeoutMs: 300_000 });
  if (uploaded.exitCode !== 0 || uploaded.stdout.trimEnd().split(/\r?\n/).at(-1) !== uploadMarker) {
    throw new BootstrapError('DAEMON_UPLOAD');
  }
  return file;
}
