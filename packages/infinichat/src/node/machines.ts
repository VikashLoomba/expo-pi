import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  acceptHostKey, connectSsh, forgetHostKey, HostKeyChangedError, HostKeyUnknownError, RemoteExecutionEnv, scanHostKey,
  type Connection, type RemoteInfo, type SshTarget,
} from '@earendil-works/pi-env';

import {
  machineEndpoint as endpoint, type Machine, type PendingHostKeys, type Reach,
} from '../pi/infinichat-remote/contract';
import type { MachinesState } from '../pi/infinichat-remote/machines';
import { MACHINE_WORK, machineDescription, type Device } from '../pi/infinichat/device-tools';

const noop = () => {};
/**
 * What a check found of a machine holds while its endpoint, the key the client pinned and the keys it authorized there
 * stay the same.
 */
const checked = (machine: Machine) => JSON.stringify([endpoint(machine), machine.hostKey?.fingerprint ?? null,
  [...(machine.authorizedKeys ?? [])].sort()]);
const without = <T>(record: Readonly<Record<string, T>>, id: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));

interface Scanned { line: string; algorithm: string; fingerprint: string }

/**
 * Each known-hosts line `scanHostKey` found (`alias type key`) with its fingerprint, which pi-env reads with
 * `ssh-keygen -l` from the same file, one line per key in its order: `bits SHA256:… alias (TYPE)`.
 */
function scanned(name: string, { lines, fingerprints }: { lines: string[]; fingerprints: string[] }): Scanned[] {
  if (lines.length !== fingerprints.length) throw new Error(`The SSH host key of ${name} could not be read.`);
  return lines.map((line, index) => ({
    line, algorithm: line.split(/\s+/)[1] ?? '', fingerprint: fingerprints[index].split(/\s+/)[1] ?? '',
  }));
}

/** Where the conversation's machines document is read from: the open core's store, or nothing while it is away. */
export interface MachinesSource {
  subscribe(listener: () => void): () => void;
  current(): MachinesState | undefined;
}

/**
 * The conversation's other machines, which InfiniChat's tools reach from here with this machine's own SSH, through
 * pi-env. The list is the conversation's machines document, read from the core while this machine holds the
 * conversation; a machine is known by its endpoint. Connections come from `connectSsh` rather than `sshConnection`,
 * because only its failures say when the host key is why (`HostKeyUnknownError`, `HostKeyChangedError`); a lazy start
 * reports them as a message. So a connection whose start fails is let go, and the next start goes through
 * `connectSsh`. A host key is trusted on first use, as the clients trust theirs (OpenSSH's `accept-new`; owner
 * decision, 2026-10-27): the key a client pinned when it has one, else the keys the scan found. Only a changed key
 * waits for a client, which is where an impersonation would show.
 */
export class ServerMachines {
  private machines: readonly Machine[] = [];
  private readonly connections = new Map<string, Promise<Connection>>();
  /** Connections that answered once: a later failed start may be a changed host key, which only `connectSsh` names. */
  private readonly answered = new WeakSet<Connection>();
  /** The scans waiting for a client, whose lines its accept trusts. */
  private readonly waiting = new Map<string, { keys: Scanned[]; changed: boolean }>();
  private reach: Reach = {};
  private pending: PendingHostKeys = {};
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private readonly knownHosts: string;
  /** The InfiniChat key the phone gave this machine (the app's `ssh-keys.ts`), once it has. */
  private readonly identity: string;

  /** `self` names this machine in messages. */
  constructor(home: string, private readonly self: string) {
    this.knownHosts = join(home, 'known_hosts');
    this.identity = join(home, 'ssh', 'id_ed25519');
  }

  /** Follows the document: the list is what the open core serves, and what it last served while none is open. */
  follow(source: MachinesSource): () => void {
    let last: MachinesState | undefined;
    const apply = () => {
      const current = source.current();
      // The source notifies of every change of the conversation; only the document's count.
      if (current === undefined || current === last) return;
      last = current;
      this.set(Object.values(current.machines));
    };
    const stop = source.subscribe(apply);
    apply();
    return stop;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getReach = () => this.reach;
  readonly getPending = () => this.pending;

  /**
   * The other machines as devices, under the names and descriptions the clients' device lists give them; this
   * machine is the list's own first device (`serverDevices`), not one reached over SSH.
   */
  devices(): Device[] {
    return this.machines.filter((machine) => machine.name !== this.self).map((machine) => ({
      name: machine.name,
      description: machineDescription(machine),
      environment: async (who: string) => {
        const { connection, info } = await this.started(machine);
        return new RemoteExecutionEnv({ connection, id: `pi-env:${endpoint(machine)}`,
          cwd: `${info.home}/${MACHINE_WORK}/${who}` });
      },
    }));
  }

  /** Takes the list as the document has it: lets go of the connections to machines gone from it, checks new ones. */
  private set(machines: readonly Machine[]): void {
    const before = new Map(this.machines.map((machine) => [endpoint(machine), checked(machine)]));
    this.machines = machines;
    const kept = new Set(machines.map(endpoint));
    for (const key of [...this.connections.keys()]) {
      if (!kept.has(key)) this.drop(key);
    }
    // A machine as it was keeps what was found of it, and its uses keep that current: the document changes with
    // every check a client runs, and checking an unauthorized machine each time costs it failed logins, for which
    // OpenSSH 9.8+ refuses every connection from here for a while (`PerSourcePenalties`), tool calls included.
    const same = (key: string) => machines.some((machine) => endpoint(machine) === key
      && before.get(key) === checked(machine));
    this.reach = Object.fromEntries(Object.entries(this.reach).filter(([key]) => same(key)));
    for (const key of [...this.waiting.keys()]) {
      if (!same(key)) this.pend(key, undefined);
    }
    this.publish();
    for (const machine of machines) {
      // This machine's own record, named as a check names it (`machineIdentity`): nothing to reach over SSH, and
      // its own address answers no SSH outside the tailnet (owner, 2026-10-29: "Can't connect" on the holder's row).
      if (machine.name === this.self) continue;
      if (this.reach[endpoint(machine)] === undefined) void this.started(machine).catch(noop);
    }
  }

  /**
   * A machine's files through this machine's own SSH, for a pull, with the account's home there. The record comes
   * from the caller: a pull runs while no conversation is open here to list it.
   */
  async environment(machine: Machine): Promise<{ env: RemoteExecutionEnv; home: string; name: string }> {
    const { connection, info } = await this.started(machine);
    return { env: new RemoteExecutionEnv({ connection, id: `pi-env:${endpoint(machine)}`, cwd: info.home }),
      home: info.home, name: machine.name };
  }

  /**
   * Trusts the keys waiting for the machine at `key` once a client accepted these fingerprints, then checks it, and
   * names the first key trusted, for the machine's record, so the next holder trusts it without asking.
   */
  async acceptHostKey(key: string, fingerprints: readonly string[]): Promise<Machine['hostKey']> {
    const machine = this.machines.find((candidate) => endpoint(candidate) === key);
    const waiting = this.waiting.get(key);
    if (machine === undefined || waiting === undefined) {
      throw new Error(`No SSH host key of that machine waits for approval on ${this.self}.`);
    }
    if (waiting.keys.length !== fingerprints.length
      || waiting.keys.some(({ fingerprint }) => !fingerprints.includes(fingerprint))) {
      throw new Error(`The SSH host key ${machine.name} presents to ${this.self} changed again. Compare it again.`);
    }
    const target = this.target(machine);
    // pi-env never replaces a trusted key: the old ones go first (`acceptHostKey`, `src/ssh.ts:258-280`).
    if (waiting.changed) await forgetHostKey(target);
    await acceptHostKey(target, waiting.keys.map(({ line }) => line));
    this.pend(key, undefined);
    // A check from before the accept would end with the key pending again; this one starts afresh.
    this.drop(key);
    this.reach = without(this.reach, key);
    this.publish();
    void this.started(machine).catch(noop);
    const [first] = waiting.keys;
    return first && { algorithm: first.algorithm, fingerprint: first.fingerprint };
  }

  /** At shutdown, once the conversation's tools stopped: stops each machine's daemon, also one still connecting. */
  close(): void {
    this.closed = true;
    for (const key of [...this.connections.keys()]) this.drop(key);
  }

  /**
   * How this machine's `ssh` reaches it: with its InfiniChat key alone when it has one, so personal keys and agents
   * stay out of it (pi-env sets `IdentitiesOnly` with `identityFile`), checking the host key against the keys trusted
   * here under its endpoint, lowercased because ssh writes a `HostKeyAlias` that way and pi-env's `acceptHostKey`
   * compares it exactly.
   */
  private target(machine: Machine): SshTarget {
    return { host: machine.hostname, port: machine.port, user: machine.username, knownHostsFile: this.knownHosts,
      hostKeyAlias: endpoint(machine).toLowerCase(),
      ...(existsSync(this.identity) ? { identityFile: this.identity } : {}) };
  }

  /** Its daemon starts through the login shell, so the tools see the PATH the account's profile sets up there. */
  private connect(machine: Machine) {
    return connectSsh({ ...this.target(machine), loginShell: true });
  }

  private drop(key: string) {
    const opening = this.connections.get(key);
    this.connections.delete(key);
    void opening?.then((connection) => connection.close(), noop);
  }

  /** Its connection, started, and what its daemon reported: what each use needs, and what `reach` shows of it. */
  private async started(machine: Machine, again = false): Promise<{ connection: Connection; info: RemoteInfo }> {
    if (this.closed) throw new Error(`InfiniChat is stopping on ${this.self}.`);
    const key = endpoint(machine);
    const opening = this.connections.get(key) ?? this.open(machine);
    this.connections.set(key, opening);
    let connection: Connection | undefined;
    try {
      connection = await opening;
      const info = await connection.info();
      this.answered.add(connection);
      this.record(machine, undefined);
      return { connection, info };
    } catch (error) {
      if (this.connections.get(key) === opening) this.drop(key);
      // A restart reports a changed host key as pi-env's own advice to remove the old key, which a model with a shell
      // here could follow; one fresh `connectSsh` names it, and the key waits for a client instead.
      if (!again && connection !== undefined && this.answered.has(connection)) return this.started(machine, true);
      this.record(machine, error);
      throw error;
    }
  }

  /** `connectSsh`, trusting the machine's host key first when it is the one the client pinned. */
  private async open(machine: Machine): Promise<Connection> {
    const target = this.target(machine);
    try {
      return (await this.connect(machine)).connection;
    } catch (error) {
      if (!(error instanceof HostKeyUnknownError) && !(error instanceof HostKeyChangedError)) throw error;
      const changed = error instanceof HostKeyChangedError;
      const keys = scanned(machine.name, await scanHostKey(target));
      const pinned = keys.filter(({ fingerprint }) => fingerprint === machine.hostKey?.fingerprint);
      if (changed && pinned.length === 0) {
        if (this.listed(machine)) this.pend(endpoint(machine), { keys, changed });
        throw new Error(`The SSH host key ${machine.name} presents to ${this.self} changed. Trust it in Remote `
          + 'machines on the phone only if you know why it changed.');
      }
      if (changed) await forgetHostKey(target);
      await acceptHostKey(target, (pinned.length > 0 ? pinned : keys).map(({ line }) => line));
      return (await this.connect(machine)).connection;
    }
  }

  private listed(machine: Machine): boolean {
    return this.machines.some((listed) => endpoint(listed) === endpoint(machine));
  }

  /** What the latest attempt found of a machine that is still listed as it was tried. */
  private record(machine: Machine, error: unknown) {
    if (!this.listed(machine)) return;
    const key = endpoint(machine);
    this.reach = { ...this.reach, [key]: error === undefined ? { reachable: true }
      : { reachable: false, error: error instanceof Error ? error.message : String(error) } };
    if (error === undefined) this.pend(key, undefined);
    this.publish();
  }

  /** Keeps a scan for a client, or lets it go, with what `pendingHostKeys` shows of it. */
  private pend(key: string, scan: { keys: Scanned[]; changed: boolean } | undefined) {
    if (scan === undefined) {
      if (this.waiting.delete(key)) this.pending = without(this.pending, key);
      return;
    }
    this.waiting.set(key, scan);
    this.pending = { ...this.pending, [key]: { changed: scan.changed,
      keys: scan.keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })) } };
  }

  private publish() {
    for (const listener of [...this.listeners]) listener();
  }
}
