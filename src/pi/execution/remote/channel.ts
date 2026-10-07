import type { SshAuth, SshConnectOptions, SshConnection, SshHostKey, SshShell } from '@osuki-dev/react-native-ssh';
import { BootstrapError } from './bootstrap-errors';
import { loadPackagedDaemon, type DaemonLoader } from './daemon-assets';
import { provisionDaemon, quotePosix, type SshSetupStage } from './provisioning';

export type { SshSetupStage } from './provisioning';

/** One owned, binary, non-PTY command channel; closing it also closes its SSH connection. */
export interface DaemonChannel {
  write(bytes: Uint8Array): void;
  close(): Promise<void>;
}

export interface DaemonChannelOpen {
  token: string;
  signal: AbortSignal;
  /** The receiver may retain these bytes. Factories must transfer or copy native-owned buffers. */
  onData(bytes: Uint8Array): void;
  onClosed(error?: Error): void;
}

export type DaemonChannelFactory = (options: DaemonChannelOpen) => Promise<DaemonChannel>;

export interface SshChannelOptions {
  host: string;
  port: number;
  username: string;
  auth: SshAuth;
  verifyHostKey(key: SshHostKey): boolean | Promise<boolean>;
  hostKeyAlgorithms?: string[];
  connectTimeoutMs?: number;
  onProgress?: (stage: SshSetupStage) => void;
}

/** Structural injection is for transport ownership tests; production uses the selected native library. */
export type SshConnector = (options: SshConnectOptions) => Promise<Pick<SshConnection, 'openShell' | 'disconnect'>>;

export interface SshChannelDependencies {
  connect?: SshConnector;
  loadDaemon?: DaemonLoader;
}

function aborted(): Error {
  return Object.assign(new Error('SSH connection cancelled.'), { code: 'CANCELLED' });
}

/** Native diagnostics may contain credential input. Only stable codes and fixed text leave this boundary. */
function connectionFailure(error: unknown): Error {
  if (error instanceof BootstrapError) return error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL';
  const messages: Record<string, string> = {
    AUTH_FAILED: 'SSH authentication failed. Check this machine’s SSH account and saved credential.',
    KEY: 'The SSH private key could not be loaded. Check its format and passphrase.',
    HOST_KEY_REJECTED: 'The SSH server key was not accepted. Test this machine and verify its fingerprint.',
    TIMEOUT: 'The SSH connection timed out. Check the Tailscale VPN and remote SSH server.',
    CANCELLED: 'SSH connection cancelled.',
    INVALID_ARGUMENT: 'The SSH configuration is invalid. Check this machine’s settings.',
    CLOSED: 'The SSH connection closed before the Pi daemon was ready.',
    PROTOCOL: 'The SSH server could not negotiate a compatible connection.',
    IO: 'The SSH connection failed while opening the Pi daemon channel.',
    QUEUE_FULL: 'The SSH server stopped accepting channel data.',
    TOO_LARGE: 'The SSH operation exceeded the transport size limit.',
    INTERNAL: 'The SSH connection could not be opened.',
  };
  let message = messages[code] ?? messages.INTERNAL!;
  if (code === 'CONNECT' || code === 'NOT_FOUND') {
    const diagnostic = error instanceof Error ? error.message : '';
    message = /dns|resolve|lookup|name or service|nodename/i.test(diagnostic)
      ? 'The Tailscale hostname could not be resolved. Check MagicDNS and the phone’s Tailscale DNS setting.'
      : 'The SSH server could not be reached through Tailscale. Check the VPN, address, and SSH port.';
  }
  return Object.assign(new Error(message), { name: 'SshConnectionError', code });
}

/** Credentials and verifier belong to the immutable host admission snapshot, never to protocol messages. */
export function createSshChannelFactory(options: SshChannelOptions, dependencies: SshChannelDependencies = {}): DaemonChannelFactory {
  const snapshot = { ...options, auth: { ...options.auth }, hostKeyAlgorithms: options.hostKeyAlgorithms?.slice() };
  return async ({ token, signal, onData, onClosed }) => {
    if (signal.aborted) throw aborted();
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid Pi synchronization token.');
    let connection: Pick<SshConnection, 'openShell' | 'disconnect'> | undefined;
    let shell: SshShell | undefined;
    let closing: Promise<void> | undefined;
    let closingRequested = false;
    let notified = false;
    const notifyClosed = (error?: Error) => {
      if (notified) return;
      notified = true;
      onClosed(error);
    };
    // Disconnect concurrently with channel close: a peer that stopped answering channel
    // requests must not prevent disposal of the transport that owns the channel.
    const dispose = (): Promise<void> => {
      closingRequested = true;
      if (closing) return closing;
      closing = Promise.allSettled([shell?.close(), connection?.disconnect()]).then(() => undefined);
      return closing;
    };
    const onAbort = () => { void dispose(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      // Metro's async-import namespace is not consistent with this package's
      // native ESM entry in Hermes. A literal require uses its normal named
      // export while still deferring Nitro loading until SSH is actually used.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const connect = dependencies.connect ?? (require('@osuki-dev/react-native-ssh') as typeof import('@osuki-dev/react-native-ssh')).connect;
      if (signal.aborted) throw aborted();
      connection = await connect({
        host: snapshot.host, port: snapshot.port, username: snapshot.username, auth: snapshot.auth,
        verifyHostKey: snapshot.verifyHostKey, hostKeyAlgorithms: snapshot.hostKeyAlgorithms,
        signal, connectTimeoutMs: snapshot.connectTimeoutMs ?? 30_000,
        keepaliveIntervalMs: 10_000, keepaliveMax: 2,
        onDisconnected: () => notifyClosed(new Error('SSH connection lost. Check the Tailscale VPN and remote host.')),
      });
      if (signal.aborted || closingRequested) {
        await connection.disconnect().catch(() => undefined);
        throw aborted();
      }
      const daemonPath = await provisionDaemon(connection, {
        signal, token, loadDaemon: dependencies.loadDaemon ?? loadPackagedDaemon, onProgress: snapshot.onProgress,
      });
      if (signal.aborted || closingRequested || notified) throw aborted();
      shell = await connection.openShell({ term: '', command: `${quotePosix(daemonPath)} serve --token ${token}` }, {
        // Native owns callback buffers. Copy immediately, before the callback returns.
        onData: (bytes) => onData(new Uint8Array(bytes).slice()),
        // Mandatory: omitting this causes native stderr to enter framed stdout.
        // Diagnostics may contain arbitrary shell startup text and are deliberately not logged.
        onStderr: () => {},
        onClosed: () => notifyClosed(closingRequested ? undefined : new Error('The Pi daemon SSH channel closed.')),
      });
      if (signal.aborted || closingRequested || notified) {
        await Promise.allSettled([shell.close(), connection.disconnect()]);
        throw signal.aborted ? aborted() : new Error('The Pi daemon SSH channel closed during startup.');
      }
      return {
        write(bytes) {
          if (closingRequested || notified || signal.aborted) throw new Error('SSH channel is closed.');
          // Own offset views as well. Native write copies synchronously into its queue.
          shell!.write(new Uint8Array(bytes));
        },
        async close() {
          signal.removeEventListener('abort', onAbort);
          await dispose();
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      // Abort can happen before either native promise delivers its resource.
      await Promise.allSettled([shell?.close(), connection?.disconnect()]);
      await dispose();
      throw connectionFailure(error);
    }
  };
}
