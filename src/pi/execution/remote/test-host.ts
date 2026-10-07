import type { SshHostKey } from '@osuki-dev/react-native-ssh';

import { createSshChannelFactory, type SshChannelDependencies, type SshSetupStage } from './channel';
import { Connection, type RemoteInfo } from './connection';
import { matchesHostKey, sameRemoteConnection, type RemoteHost, type RemoteHostRepository } from './hosts';

export interface HostKeyChallenge {
  readonly host: RemoteHost;
  readonly observed: Readonly<SshHostKey>;
  readonly trusted?: Readonly<SshHostKey>;
}
export interface RemoteHostTestOptions {
  signal: AbortSignal;
  /** Only explicit settings tests may ask the user to accept an unknown/changed key. */
  onHostKey?: (challenge: HostKeyChallenge) => Promise<boolean>;
  onProgress?: (stage: SshSetupStage) => void;
}
export interface RemoteHostTestResult { version: string; os: string; arch: string; home: string }
export type RemoteDirectoryOptions = Pick<RemoteHostTestOptions, 'signal' | 'onProgress'>;
export interface RemoteDirectoryResult { cwd: string; host: RemoteHost }

/** Stable, sanitized user feedback. Never display native errors containing secret input or remote stderr. */
export function remoteHostConnectionMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'AUTH_FAILED') return 'SSH authentication failed. Check the SSH username and password or private key in this machine’s settings.';
  if (code === 'KEY') return 'The SSH private key could not be unlocked. Check the key format and passphrase.';
  if (code === 'HOST_KEY_REJECTED') return 'The SSH server key was not accepted. Test the connection and compare its fingerprint with the remote machine.';
  if (code === 'CONNECT' || code === 'NOT_FOUND') {
    const detail = error instanceof Error ? error.message : '';
    return /dns|resolve|lookup|name or service|nodename/i.test(detail)
      ? 'The Tailscale hostname could not be resolved. Check the full MagicDNS name and enable Tailscale DNS on this phone.'
      : 'The SSH server could not be reached through Tailscale. Check the VPN on both devices, the hostname, SSH port, and tailnet access rules.';
  }
  if (code === 'TIMEOUT') return 'The SSH connection timed out. Check Tailscale connectivity and the SSH server, then test again.';
  if (code === 'CANCELLED' || code === 'aborted') return 'Remote connection cancelled.';
  if (code === 'not_found' || code === 'not_directory' || code === 'ENOENT' || code === 'ENOTDIR') return 'The working directory does not exist or is not a directory on this machine.';
  if (code === 'permission_denied' || code === 'EACCES' || code === 'EPERM') return 'The SSH account cannot access this working directory.';
  if (code === 'not_supported') return 'This remote operating system is not supported by the mobile execution environment. Configure a machine with POSIX paths.';
  if (code === 'UNSUPPORTED_REMOTE') return 'This machine’s operating system or processor is not supported for automatic remote execution setup.';
  if (code === 'DAEMON_ASSET') return 'The app’s bundled remote execution software is unavailable or damaged. Reinstall the app, then test the connection again.';
  if (code === 'DAEMON_SETUP') return 'Remote execution could not be set up. Check that the SSH account can write to its home directory, then try again.';
  if (code === 'DAEMON_UPLOAD') return 'Remote execution software could not be transferred. Check the connection and available space on the machine, then try again.';
  if (code === 'DAEMON_VERIFY') return 'The remote execution software could not be verified. The machine needs sha256sum, shasum, or openssl for SHA-256 verification.';
  return 'Remote execution could not be prepared or verified. Check the connection and try again.';
}

async function withRemoteHost<T>(repository: RemoteHostRepository, id: string, options: RemoteHostTestOptions,
  action: (connection: Connection, host: RemoteHost, info: RemoteInfo) => Promise<T>,
  dependencies?: SshChannelDependencies): Promise<T> {
  options.signal.throwIfAborted();
  const admission = await repository.admit(id);
  options.signal.throwIfAborted();
  const { host, auth, trustedHostKey } = admission;
  let accepted = trustedHostKey;
  let trustFailure: Error | undefined;
  const connection = new Connection({
    // Host verification is interactive and first connection may upload the
    // bundled runtime; the transport bounds each setup stage independently.
    startTimeoutMs: 450_000,
    openChannel: createSshChannelFactory({
      host: host.hostname, port: host.port, username: host.username, auth,
      connectTimeoutMs: 120_000,
      onProgress: options.onProgress,
      hostKeyAlgorithms: trustedHostKey ? [trustedHostKey.algorithm] : undefined,
      verifyHostKey: async (observed) => {
        if (options.signal.aborted) return false;
        if (matchesHostKey(accepted, observed)) return true;
        if (!options.onHostKey) return false;
        const key = Object.freeze({ algorithm: observed.algorithm, fingerprint: observed.fingerprint, publicKey: observed.publicKey });
        const approved = await options.onHostKey(Object.freeze({ host, observed: key, ...(trustedHostKey ? { trusted: trustedHostKey } : {}) }));
        if (!approved || options.signal.aborted) return false;
        try {
          await repository.acceptHostKey(host, key);
          accepted = key;
          return !options.signal.aborted;
        } catch (error) {
          trustFailure = error instanceof Error ? error : new Error('Could not save the accepted host key.');
          return false;
        }
      },
    }, dependencies),
  });
  // Each settings operation owns this connection. Read-only path validation
  // must also stop when a filesystem request ignores protocol cancellation.
  const abort = () => { void connection.close(); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const info = await connection.info(options.signal);
    if (info.separator !== '/' || info.os === 'windows') throw Object.assign(new Error('Unsupported remote operating system.'), { code: 'not_supported' });
    return await action(connection, host, info);
  } catch (error) {
    if (trustFailure) throw trustFailure;
    if (options.signal.aborted) throw Object.assign(new Error('Remote connection cancelled.'), { code: 'aborted' });
    throw new Error(remoteHostConnectionMessage(error));
  } finally {
    options.signal.removeEventListener('abort', abort);
    await connection.close();
  }
}

/** Verify the machine's SSH trust, automatic setup and daemon handshake independently of any chat directory. */
export function testRemoteHost(repository: RemoteHostRepository, id: string, options: RemoteHostTestOptions,
  dependencies?: SshChannelDependencies): Promise<RemoteHostTestResult> {
  return withRemoteHost(repository, id, options, async (_connection, _host, info) =>
    ({ version: info.version, os: info.os, arch: info.arch, home: info.home }), dependencies);
}

/**
 * Resolve a chat's directory using an already trusted machine. Empty input uses
 * the remote account's home. The caller must recheck the connection settings immediately
 * before committing the chat selection, since host edits can follow this return.
 */
export async function resolveRemoteWorkingDirectory(repository: RemoteHostRepository, id: string, path: string,
  options: RemoteDirectoryOptions, dependencies?: SshChannelDependencies): Promise<RemoteDirectoryResult> {
  const requested = path.trim() ? path : '';
  if (requested && (!requested.startsWith('/') || /[\x00-\x1f\x7f]/.test(requested))) {
    throw new Error('Enter an absolute working directory starting with /, or leave it empty to use the remote home directory.');
  }
  const result = await withRemoteHost(repository, id, { signal: options.signal, onProgress: options.onProgress },
    async (connection, host, info) => {
      const session = connection.currentSession;
      if (session === undefined) throw new Error('The remote connection closed.');
      const resolved = await connection.request('realpath', { path: requested || info.home }, { signal: options.signal, session });
      const cwd = resolved.json.path;
      if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(cwd)) {
        throw new Error('The daemon returned an invalid working directory.');
      }
      const directory = await connection.request('lstat', { path: cwd }, { signal: options.signal, session });
      if (directory.json.kind !== 'directory') throw Object.assign(new Error('The working directory is not a directory.'), { code: 'not_directory' });
      return { cwd, host };
    }, dependencies);
  options.signal.throwIfAborted();
  if (!sameRemoteConnection(repository.get(id), result.host)) throw new Error('This machine changed. Select it again and retry saving the chat settings.');
  return result;
}
