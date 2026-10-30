import type { Link } from '@earendil-works/chord';

import type { Machine } from './contract';

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
