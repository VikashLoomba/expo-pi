import type { Link } from '@earendil-works/chord';

import type { Machine } from './contract';

/** The steps of an install a dial runs, as the connection status shows them. */
export type InstallStage = 'connecting' | 'checking' | 'uploading' | 'starting';

export interface DialOptions {
  /** The attempt's signal: a dial it cancels closes what it opened. */
  signal: AbortSignal;
  /** Progress of an install the dial runs. */
  onStage(stage: InstallStage): void;
  /** An install finished, with what it wants the user to know; a refusal after it is final. */
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
  /** The server this app may use: its bundle, and the device name and description the device list gives it. */
  expected: { bundle: string; device: string; description: string };
  /**
   * Installs or updates the server over the same transport, with the dial's options, and returns a new link to it;
   * the previous link closes.
   */
  reinstall(): Promise<Link>;
  /** Closes the link, then its transport. */
  close(): Promise<void>;
}

/** The machine as this app knows it, and the other machines the server's tools reach. */
export interface MachineDirectory {
  /** The machine's ID in this app's list. */
  readonly id: string;
  /** Its name, or undefined once it is gone from this app's list. */
  name(): string | undefined;
  /** As `setMachines` sends them: never credentials, with the host key this app pinned, if any. */
  others(): Promise<Machine[]>;
  subscribe(listener: () => void): () => void;
}
