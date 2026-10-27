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
   * Installs or updates the server as `dial` does, with the dial's options, then tunnels again over the dial's
   * transport and returns a new link; the previous link and tunnel close. The install needn't use that transport:
   * the phone's goes through the machine's `ExecutionEnv`, borrowed from the owner of its daemon connection.
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
  /** Its endpoint as the servers know it (`machineEndpoint`), or undefined once it is gone. */
  endpoint(): string | undefined;
  /** Its InfiniChat SSH public key, once this app's key exchange learned it there. */
  publicKey(): string | undefined;
  /** As `setMachines` sends them: never credentials, with the host key this app pinned, if any. */
  others(): Promise<Machine[]>;
  subscribe(listener: () => void): () => void;
}
