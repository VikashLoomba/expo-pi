import {
  connect, isSshError, type SshAuth, type SshConnection, type SshHostKey, type SshShell,
} from '@automatalabs/react-native-ssh';
import { BootstrapError } from './bootstrap-errors';
import { provisionDaemon, quotePosix, type RemotePlatformState, type SshSetupStage } from './provisioning';
import { exchangeKeys, type KeyExchange } from './ssh-keys';
import { tailscaleSignIn } from './tailscale';

export type { SshSetupStage } from './provisioning';

/** One owned, binary, non-PTY command channel; closing it also closes its SSH connection. */
export interface DaemonChannel {
  /** Sends in order; what the transport can't take yet waits, so only a failed channel throws. */
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
  /** The connection's detected platform, shared by its starts; by default this factory's own. */
  platform?: RemotePlatformState;
  /** The machine's InfiniChat key exchange, run once the daemon is provisioned. */
  keys?: KeyExchange;
}

function aborted(): Error {
  return Object.assign(new Error('SSH connection cancelled.'), { code: 'CANCELLED' });
}

/** Native diagnostics may contain credential input. Only stable codes and fixed text leave this boundary. */
export function connectionFailure(error: unknown): Error {
  if (error instanceof BootstrapError) return error;
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL';
  const messages: Record<string, string> = {
    AUTH_FAILED: 'SSH authentication failed. Check this machine’s SSH account and saved credential.',
    KEY: 'The SSH private key could not be loaded. Check its format and passphrase.',
    HOST_KEY_REJECTED: 'This machine’s SSH host key changed since it was trusted. If you reinstalled or replaced it, '
      + 'choose Trust new key in Remote machines.',
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
  let message = messages[code] ?? messages.INTERNAL;
  if (code === 'CONNECT' || code === 'NOT_FOUND') {
    const diagnostic = error instanceof Error ? error.message : '';
    message = /dns|resolve|lookup|name or service|nodename/i.test(diagnostic)
      ? 'The Tailscale hostname could not be resolved. Check MagicDNS and the phone’s Tailscale DNS setting.'
      : 'The SSH server could not be reached through Tailscale. Check the VPN, address, and SSH port.';
  }
  return Object.assign(new Error(message), { name: 'SshConnectionError', code });
}

/** Credentials and verifier belong to the immutable host admission snapshot, never to protocol messages. */
export function createSshChannelFactory(options: SshChannelOptions): DaemonChannelFactory {
  const snapshot = { ...options, auth: { ...options.auth }, hostKeyAlgorithms: options.hostKeyAlgorithms?.slice() };
  const platform: RemotePlatformState = options.platform ?? {};
  return async ({ token, signal, onData, onClosed }) => {
    if (signal.aborted) throw aborted();
    if (!/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid Pi synchronization token.');
    let connection: SshConnection | undefined;
    let shell: SshShell | undefined;
    let closing: Promise<void> | undefined;
    let closingRequested = false;
    let notified = false;
    // pi-env's client writes its frames to the daemon's stdin, which keeps in memory whatever the daemon hasn't read
    // yet. The native queue refuses a write instead once it is full (`QUEUE_FULL`, accepting none of the bytes), so
    // refused frames wait here, in order, and are offered again every 10 ms, as `command-channel.ts` retries.
    const waiting: Uint8Array[] = [];
    let retry: ReturnType<typeof setTimeout> | undefined;
    const notifyClosed = (error?: Error) => {
      if (notified) return;
      notified = true;
      onClosed(error);
    };
    // Disconnect concurrently with channel close: a peer that stopped answering channel
    // requests must not prevent disposal of the transport that owns the channel.
    const dispose = (): Promise<void> => {
      closingRequested = true;
      clearTimeout(retry);
      waiting.length = 0;
      if (closing) return closing;
      closing = Promise.allSettled([shell?.close(), connection?.disconnect()]).then(() => undefined);
      return closing;
    };
    const onAbort = () => { void dispose(); };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const signIn = tailscaleSignIn();
      try {
        connection = await connect({
          host: snapshot.host, port: snapshot.port, username: snapshot.username, auth: snapshot.auth,
          verifyHostKey: snapshot.verifyHostKey, hostKeyAlgorithms: snapshot.hostKeyAlgorithms,
          signal, connectTimeoutMs: snapshot.connectTimeoutMs, onBanner: signIn.onBanner,
          onDisconnected: () =>
            notifyClosed(new Error('SSH connection lost. Check the Tailscale VPN and remote host.')),
        });
      } finally {
        signIn.settled();
      }
      if (signal.aborted || closingRequested) {
        await connection.disconnect().catch(() => undefined);
        throw aborted();
      }
      const daemonPath = await provisionDaemon(connection, {
        signal, token, platform, onProgress: snapshot.onProgress,
      });
      if (signal.aborted || closingRequested || notified) throw aborted();
      if (snapshot.keys) {
        const keys = await exchangeKeys(connection, snapshot.keys.others(), { signal, token });
        if (signal.aborted || closingRequested || notified) throw aborted();
        // The record is for the next exchange; one that can't be written now doesn't stop this connection, and this
        // connection never waits for it: the record is a call on the machine's InfiniChat, which waits for its link,
        // and a dial after the background opens this very connection before the link (2026-10-29: the two waited for
        // each other until the app was quit).
        void snapshot.keys.store(keys).catch(() => {});
      }
      // Through the login shell, as pi-env's `loginShell` starts its daemon (`launchCommand`, `dist/ssh.js:392-403` at
      // v1.4.0), so commands see the PATH the account's profile sets up. The decoder skips what the profile prints.
      const command = `exec "$SHELL" -lc 'exec "$0" "$@"' ${quotePosix(daemonPath)} serve --token ${token}`;
      const daemon = await connection.openShell({ term: '', command }, {
        // Native owns callback buffers. Copy immediately, before the callback returns.
        onData: (bytes) => onData(new Uint8Array(bytes).slice()),
        // Mandatory: omitting this causes native stderr to enter framed stdout.
        // Diagnostics may contain arbitrary shell startup text and are deliberately not logged.
        onStderr: () => {},
        onClosed: () => notifyClosed(closingRequested ? undefined : new Error('The Pi daemon SSH channel closed.')),
      });
      shell = daemon;
      if (signal.aborted || closingRequested || notified) {
        await Promise.allSettled([daemon.close(), connection.disconnect()]);
        throw signal.aborted ? aborted() : new Error('The Pi daemon SSH channel closed during startup.');
      }
      /** Writes what waits, in order, until the native queue refuses it; any other failure is thrown. */
      const flush = () => {
        retry = undefined;
        while (waiting.length > 0) {
          try {
            daemon.write(waiting[0]);
          } catch (error) {
            if (!isSshError(error, 'QUEUE_FULL')) throw error;
            retry = setTimeout(() => {
              if (closingRequested || notified || signal.aborted) return;
              try {
                flush();
              } catch {
                notifyClosed(new Error('SSH could not send the Pi request.'));
              }
            }, 10);
            return;
          }
          waiting.shift();
        }
      };
      return {
        write(bytes) {
          if (closingRequested || notified || signal.aborted) throw new Error('SSH channel is closed.');
          // Own offset views as well: a refused frame waits, and native write copies synchronously into its queue.
          waiting.push(new Uint8Array(bytes));
          if (retry === undefined) flush();
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
