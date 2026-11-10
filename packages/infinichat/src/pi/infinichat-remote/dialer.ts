import type { Link } from '@earendil-works/chord';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

import type { CredentialBackend } from '../provider-credentials';
import type { Machine } from './contract';
import { installServer, machineSecret, requestUpdate, runningServer, savedSecret } from './install';

/** The steps of an install a dial runs, as the connection status shows them. */
export type InstallStage = 'connecting' | 'checking' | 'installing' | 'starting';

export interface DialOptions {
  /** The attempt's signal: a dial it cancels closes what it opened. */
  signal: AbortSignal;
  /** Progress of an install the dial runs. */
  onStage(stage: InstallStage): void;
  /** A setup finished, with what it wants the user to know; a refusal after it is final. */
  onInstalled(notice: string | undefined): void;
  /** The transport under the link went away, such as the SSH session or its tunnel. */
  onDropped(): void;
}

/** How one app reaches one machine's InfiniChat server and gets a Chord link to it. */
export interface ServerDialer {
  dial(options: DialOptions): Promise<DialedServer>;
}

/** A dialed server, whose link and transport belong to the dialer until `close`. */
export interface DialedServer {
  link: Link;
  /** The machine's name as this app lists it, for messages before its machines document arrives. */
  name: string;
  /** The server's release (`release.ts`). */
  version: string;
  /**
   * Writes this app's key again and starts the server when it isn't running (`installServer`), with the dial's
   * options, then tunnels again over the dial's transport and returns a new link; the previous link and tunnel close.
   * That step needn't use the transport: the phone's goes through the machine's `ExecutionEnv`, borrowed from the
   * owner of its daemon connection.
   */
  install(): Promise<Link>;
  /** Asks the server to update itself now (`requestUpdate`). */
  requestUpdate(): Promise<void>;
  /** Closes the link, then its transport. */
  close(): Promise<void>;
}

/** A server to open a link to: its port on the machine's loopback, this app's secret for it, and its release. */
export interface ServerTarget { port: number; secret: string; version: string }

/** What a dialer gives `dialServer`: the machine as the app knows it, and its own transport to the server. */
export interface DialTransport {
  /** The machine's ID in this app, which its secret is kept under. */
  machineId: string;
  /** Its name, for messages, and the account an install's advice names. */
  name: string;
  username: string;
  /** This app's client ID, which its secret is written under on the machine. */
  client: string;
  /** The machine's files and commands, borrowed from their owner, for the check and an install. */
  environment(): Promise<ExecutionEnv>;
  credentials: CredentialBackend;
  randomBytes(count: number): Promise<Uint8Array>;
  /** Opens a link to the server at `target`, closing the one it opened before. */
  open(target: ServerTarget): Link | Promise<Link>;
  /** Closes the link, then what carries it. */
  close(): Promise<void>;
}

/**
 * What every dialer decides, whatever carries its link: with a secret for the machine and a live server named in
 * `server.json`, it opens a link to that server; otherwise it writes the secret as this app's client file there and
 * starts the server, setting one up first on a machine with none (`installServer`). A dial that fails closes what
 * the transport opened.
 */
export async function dialServer(transport: DialTransport,
  { signal, onStage, onInstalled }: Pick<DialOptions, 'signal' | 'onStage' | 'onInstalled'>): Promise<DialedServer> {
  const { machineId, name, credentials } = transport;
  const install = async (): Promise<ServerTarget> => {
    const secret = await machineSecret(credentials, transport.randomBytes, machineId);
    const server = await installServer({ machine: await transport.environment(), name, username: transport.username },
      transport.client, secret, { signal, onProgress: onStage });
    onInstalled(server.notice);
    return server;
  };
  try {
    const secret = await savedSecret(credentials, machineId);
    const running = secret === undefined ? undefined
      : await runningServer(await transport.environment(), name, signal);
    const target = secret !== undefined && running !== undefined ? { ...running, secret } : await install();
    return {
      link: await transport.open(target),
      name,
      version: target.version,
      install: async () => transport.open(await install()),
      requestUpdate: async () => requestUpdate(await transport.environment(), name, signal),
      close: () => transport.close(),
    };
  } catch (error) {
    await transport.close();
    throw error;
  }
}

/**
 * A machine as the conversation's machines document lists it (`machines.ts`), read from the side this app shows: the
 * holder's own document, or the last one a held side showed while a move is under way.
 */
export interface MachineDirectory {
  /** The machine's endpoint (`machineEndpoint`), its ID everywhere. */
  readonly id: string;
  /** Its record, or undefined once it is gone from the document. */
  machine(): Machine | undefined;
  subscribe(listener: () => void): () => void;
}
