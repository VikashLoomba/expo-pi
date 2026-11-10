import {
  acceptHostKey, forgetHostKey, HostKeyChangedError, HostKeyUnknownError, scanHostKey, type Connection,
  type SshTarget,
} from '@earendil-works/pi-env';

const noop = () => {};

/** A host key a scan found: its known-hosts line, and what a person compares. */
export interface ScannedHostKey { line: string; algorithm: string; fingerprint: string }
/** The keys a machine presents that are not trusted here; `changed` when they replace a trusted one. */
export interface HostKeyScan { keys: ScannedHostKey[]; changed: boolean }

/**
 * Each known-hosts line `scanHostKey` found (`alias type key`) with its fingerprint, which pi-env reads with
 * `ssh-keygen -l` from the same file, one line per key in its order: `bits SHA256:… alias (TYPE)`.
 */
function scanned(name: string, { lines, fingerprints }: { lines: string[]; fingerprints: string[] }): ScannedHostKey[] {
  if (lines.length !== fingerprints.length) throw new Error(`The SSH host key of ${name} could not be read.`);
  return lines.map((line, index) => ({
    line, algorithm: line.split(/\s+/)[1] ?? '', fingerprint: fingerprints[index].split(/\s+/)[1] ?? '',
  }));
}

/**
 * Connects with `connect`, the caller's own `connectSsh`, trusting the machine's host key on first use, as OpenSSH's
 * `accept-new` does (owner decision, 2026-10-27): keys there are none for are trusted, and it connects again.
 * `connectSsh` rather than a lazy connection, because only its failures say when the host key is why. A changed key
 * is where an impersonation would show, so it is never trusted here: `changed` takes the scan for a person to decide
 * on and gives the error to end with. The exception is the key `pinned` names, which a client already accepted: it
 * replaces the old one.
 */
export async function connectTrusting(target: SshTarget, name: string, connect: () => Promise<Connection>,
  options: { pinned?: string; changed(scan: HostKeyScan): Error }): Promise<Connection> {
  try {
    return await connect();
  } catch (error) {
    if (!(error instanceof HostKeyUnknownError) && !(error instanceof HostKeyChangedError)) throw error;
    const changed = error instanceof HostKeyChangedError;
    const keys = scanned(name, await scanHostKey(target));
    const pinned = keys.filter(({ fingerprint }) => fingerprint === options.pinned);
    if (changed && pinned.length === 0) throw options.changed({ keys, changed });
    // pi-env never replaces a trusted key: the old ones go first (`acceptHostKey`, `src/ssh.ts:258-280`).
    if (changed) await forgetHostKey(target);
    await acceptHostKey(target, (pinned.length > 0 ? pinned : keys).map(({ line }) => line));
    return connect();
  }
}

/** One connection per machine, by endpoint: started once, kept for the next use, and closed when it is dropped. */
export class ConnectionPool {
  private readonly connections = new Map<string, Promise<Connection>>();

  /** The connection at `key`, started with `open` when there is none; a start that fails is let go. */
  get(key: string, open: () => Promise<Connection>): Promise<Connection> {
    const kept = this.connections.get(key);
    if (kept !== undefined) return kept;
    const opening = open();
    this.connections.set(key, opening);
    opening.catch(() => {
      if (this.connections.get(key) === opening) this.connections.delete(key);
    });
    return opening;
  }

  /** Whether `opening` is still the connection kept at `key`. */
  holds(key: string, opening: Promise<Connection>): boolean {
    return this.connections.get(key) === opening;
  }

  keys(): string[] {
    return [...this.connections.keys()];
  }

  /** Lets go of the connection at `key` and closes it, also one that is still starting. */
  drop(key: string): void {
    const opening = this.connections.get(key);
    this.connections.delete(key);
    void opening?.then((connection) => connection.close(), noop);
  }
}
