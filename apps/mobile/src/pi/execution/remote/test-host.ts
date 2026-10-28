import { createSshChannelFactory, type SshSetupStage } from './channel';
import { Connection, RemoteError } from './connection';
import { hostKeyPolicy, type RemoteHostRepository } from './hosts';
import { machineKeyExchange } from './ssh-keys';

export interface RemoteHostTestOptions {
  signal: AbortSignal;
  onProgress?: (stage: SshSetupStage) => void;
}
export interface RemoteHostTestResult { version: string; os: string; arch: string; home: string }

/** What each setup stage says while a machine is prepared, on the machine form and in Remote machines. */
export const setupStageLabels: Record<SshSetupStage, string> = {
  detecting: 'Checking remote machine…',
  checking: 'Verifying remote setup…',
  uploading: 'Preparing remote execution…',
};

/** The code a failure carries, by which Remote machines offers the fix for a changed host key. */
export const failureCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/** Stable, sanitized user feedback. Never display native errors containing secret input or remote stderr. */
function remoteHostConnectionMessage(error: unknown): string {
  const code = failureCode(error);
  if (code === 'AUTH_FAILED') return 'SSH authentication failed. Check the SSH username and password or private key in this machine’s settings.';
  if (code === 'KEY') return 'The SSH private key could not be unlocked. Check the key format and passphrase.';
  if (code === 'HOST_KEY_REJECTED') {
    return 'This machine’s SSH host key changed since it was trusted. If you reinstalled or replaced the machine, '
      + 'choose Trust new key.';
  }
  if (code === 'CONNECT' || code === 'NOT_FOUND') {
    const detail = error instanceof Error ? error.message : '';
    return /dns|resolve|lookup|name or service|nodename/i.test(detail)
      ? 'The Tailscale hostname could not be resolved. Check the full MagicDNS name and enable Tailscale DNS on this phone.'
      : 'The SSH server could not be reached through Tailscale. Check the VPN on both devices, the hostname, SSH port, and tailnet access rules.';
  }
  if (code === 'TIMEOUT') return 'The SSH connection timed out. Check Tailscale connectivity and the SSH server, then test again.';
  if (code === 'CANCELLED' || code === 'aborted') return 'Remote connection cancelled.';
  if (code === 'not_supported') return 'This remote operating system is not supported by the mobile execution environment. Configure a machine with POSIX paths.';
  if (code === 'UNSUPPORTED_REMOTE') return 'This machine’s operating system or processor is not supported for automatic remote execution setup.';
  if (code === 'DAEMON_ASSET') return 'The app’s bundled remote execution software is unavailable or damaged. Reinstall the app, then test the connection again.';
  if (code === 'DAEMON_SETUP') return 'Remote execution could not be set up. Check that the SSH account can write to its home directory, then try again.';
  if (code === 'DAEMON_UPLOAD') return 'Remote execution software could not be transferred. Check the connection and available space on the machine, then try again.';
  if (code === 'DAEMON_VERIFY') return 'The remote execution software could not be verified. The machine needs sha256sum, shasum, or openssl for SHA-256 verification.';
  if (code === 'SSH_KEYS') {
    return 'The machine’s InfiniChat SSH key could not be set up. Check that ssh-keygen is available there and that '
      + 'the SSH account can write to its home directory.';
  }
  if (code === 'AUTHORIZED_KEYS') {
    return 'The SSH account can neither write nor read its ~/.ssh/authorized_keys on the machine, so the other '
      + 'machines’ keys can’t be authorized there. Make that file the account’s own, then test again.';
  }
  return 'Remote execution could not be prepared or verified. Check the connection and try again.';
}

/**
 * Connects to the machine, trusting its SSH host key on first use (`hostKeyPolicy`), prepares it for remote
 * execution and reports what its daemon says, independently of any chat directory. A failure carries its code.
 */
export async function testRemoteHost(repository: RemoteHostRepository, id: string,
  options: RemoteHostTestOptions): Promise<RemoteHostTestResult> {
  options.signal.throwIfAborted();
  const admission = await repository.admit(id);
  options.signal.throwIfAborted();
  const { host, auth } = admission;
  const connection = new Connection({
    openChannel: createSshChannelFactory({
      host: host.hostname, port: host.port, username: host.username, auth, keys: machineKeyExchange(repository, host),
      onProgress: options.onProgress, ...hostKeyPolicy(repository, admission),
    }),
  });
  // The test owns this connection; closing it is what stops connecting and requests on abort.
  const abort = () => { void connection.close(); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const info = await connection.info();
    if (info.separator !== '/' || info.os === 'windows') throw Object.assign(new Error('Unsupported remote operating system.'), { code: 'not_supported' });
    return { version: info.version, os: info.os, arch: info.arch, home: info.home };
  } catch (error) {
    if (options.signal.aborted) throw Object.assign(new Error('Remote connection cancelled.'), { code: 'aborted' });
    // A start that fails is lost, as pi-env marks it; the SSH or setup failure it keeps has the code.
    const cause = error instanceof RemoteError && error.cause ? error.cause : error;
    throw Object.assign(new Error(remoteHostConnectionMessage(cause)), { code: failureCode(cause) });
  } finally {
    options.signal.removeEventListener('abort', abort);
    await connection.close();
  }
}
