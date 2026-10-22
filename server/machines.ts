import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  acceptHostKey, connectSsh, forgetHostKey, HostKeyChangedError, HostKeyUnknownError, RemoteExecutionEnv, scanHostKey,
  type Connection, type RemoteInfo, type SshTarget,
} from '@earendil-works/pi-env';

import type { Machine, PendingHostKeys, Reach } from '../src/pi/infinichat-remote/contract';
import { MACHINE_WORK, machineDescription, type Device } from '../src/pi/infinichat/device-tools';

const noop = () => {};
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
/** What a machine's connection depends on; a name or a pinned key may change under the same connection. */
const endpoint = ({ id, hostname, port, username }: Machine) => JSON.stringify([id, hostname, port, username]);

/** A machine as `machines.json` keeps it, or none when it isn't one. */
function machineOf(value: unknown): Machine[] {
  if (!isRecord(value)) return [];
  const { id, name, hostname, port, username, hostKey } = value;
  if (typeof id !== 'string' || typeof name !== 'string' || typeof hostname !== 'string' || typeof port !== 'number'
    || typeof username !== 'string') return [];
  const pinned = isRecord(hostKey) && typeof hostKey.algorithm === 'string' && typeof hostKey.fingerprint === 'string'
    ? { algorithm: hostKey.algorithm, fingerprint: hostKey.fingerprint }
    : undefined;
  return [{ id, name, hostname, port, username, ...(pinned === undefined ? {} : { hostKey: pinned }) }];
}

/** The kept list; none before the phone's first, and none from a file that doesn't parse, which its next replaces. */
function readMachines(file: string): Machine[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const machines: unknown = JSON.parse(text);
    return Array.isArray(machines) ? machines.flatMap((machine: unknown) => machineOf(machine)) : [];
  } catch {
    return [];
  }
}

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

/**
 * The other configured machines, which InfiniChat's tools reach from here with this machine's own SSH keys and agent,
 * through pi-env. The phone sends them on every connect and whenever Remote machines change, never their credentials;
 * `machines.json` keeps them while it is away.
 *
 * Each machine has one pi-env `Connection`, opened with `connectSsh` on first use and closed at shutdown; host keys are
 * trusted in `known_hosts` here under the machine's ID. A connection whose start fails holds nothing and is let go, so
 * the next use opens it again with `connectSsh`, whose failures say when the host key is why: `sshConnection` reports
 * those as a message only. A key this machine doesn't trust yet is scanned. The one the phone pinned is accepted,
 * since the owner compared it out of band there; any other waits in `pendingHostKeys` until the phone accepts it.
 * `reach` is what the latest attempt on each machine found, for Remote machines; a new list tries each one.
 */
export class ServerMachines {
  private machines: readonly Machine[];
  private readonly connections = new Map<string, Promise<Connection>>();
  /** The scans waiting for the phone, with the lines it would accept. */
  private readonly waiting = new Map<string, { lines: string[]; keys: Scanned[]; changed: boolean }>();
  private reach: Reach = {};
  private pending: PendingHostKeys = {};
  private readonly listeners = new Set<() => void>();
  private closed = false;
  private readonly file: string;
  private readonly knownHosts: string;

  /** `self` names this machine in messages. */
  constructor(home: string, private readonly self: string) {
    this.file = join(home, 'machines.json');
    this.knownHosts = join(home, 'known_hosts');
    this.machines = readMachines(this.file);
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getReach = () => this.reach;
  readonly getPending = () => this.pending;

  /** The machines as devices, under the names and descriptions the phone's device list gives them. */
  devices(): Device[] {
    return this.machines.map((machine) => ({
      name: machine.name,
      description: machineDescription(machine),
      environment: async (who: string) => {
        const { connection, info } = await this.started(machine);
        return new RemoteExecutionEnv({ connection, id: `pi-env:${machine.id}`,
          cwd: `${info.home}/${MACHINE_WORK}/${who}` });
      },
    }));
  }

  /** Keeps the phone's list, lets go of the connections to machines it removed or moved, and tries each machine. */
  set(machines: readonly Machine[]): void {
    const temporary = `${this.file}.${process.pid}`;
    writeFileSync(temporary, JSON.stringify(machines), { mode: 0o600 });
    renameSync(temporary, this.file);
    const before = new Map(this.machines.map((machine) => [machine.id, endpoint(machine)]));
    this.machines = machines;
    const kept = new Set(machines.map(endpoint));
    for (const [key, opening] of this.connections) {
      if (kept.has(key)) continue;
      this.connections.delete(key);
      void opening.then((connection) => connection.close(), noop);
    }
    const same = (id: string) => machines.some((machine) => machine.id === id && before.get(id) === endpoint(machine));
    this.reach = Object.fromEntries(Object.entries(this.reach).filter(([id]) => same(id)));
    for (const id of this.waiting.keys()) {
      if (!same(id)) this.waiting.delete(id);
    }
    this.publish();
    for (const machine of machines) void this.started(machine).catch(noop);
  }

  /** Trusts the keys waiting for machine `id` once the phone accepted these fingerprints, then tries it again. */
  async acceptHostKey(id: string, fingerprints: readonly string[]): Promise<void> {
    const machine = this.machines.find((candidate) => candidate.id === id);
    const waiting = this.waiting.get(id);
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
    await acceptHostKey(target, waiting.lines);
    this.waiting.delete(id);
    this.publish();
    void this.started(machine).catch(noop);
  }

  /** At shutdown, once the conversation's tools stopped: stops each machine's daemon, also one still connecting. */
  close(): void {
    this.closed = true;
    for (const opening of this.connections.values()) void opening.then((connection) => connection.close(), noop);
    this.connections.clear();
  }

  /** How this machine's `ssh` reaches it, checking its host key against the keys trusted here under its ID. */
  private target(machine: Machine): SshTarget {
    return { host: machine.hostname, port: machine.port, user: machine.username, knownHostsFile: this.knownHosts,
      hostKeyAlias: machine.id };
  }

  /** Its connection, started, and what its daemon reported: what each use needs, and what `reach` shows of it. */
  private async started(machine: Machine): Promise<{ connection: Connection; info: RemoteInfo }> {
    if (this.closed) throw new Error(`InfiniChat is stopping on ${this.self}.`);
    const key = endpoint(machine);
    const opening = this.connections.get(key) ?? this.open(machine);
    this.connections.set(key, opening);
    try {
      const connection = await opening;
      const info = await connection.info();
      this.record(machine, undefined);
      return { connection, info };
    } catch (error) {
      if (this.connections.get(key) === opening) {
        this.connections.delete(key);
        void opening.then((connection) => connection.close(), noop);
      }
      this.record(machine, error);
      throw error;
    }
  }

  /** `connectSsh`, trusting the machine's host key first when it is the one the phone pinned. */
  private async open(machine: Machine): Promise<Connection> {
    const target = this.target(machine);
    try {
      return (await connectSsh(target)).connection;
    } catch (error) {
      if (!(error instanceof HostKeyUnknownError) && !(error instanceof HostKeyChangedError)) throw error;
      const changed = error instanceof HostKeyChangedError;
      const keys = scanned(machine.name, await scanHostKey(target));
      const pinned = keys.filter(({ fingerprint }) => fingerprint === machine.hostKey?.fingerprint);
      if (pinned.length === 0) {
        if (this.listed(machine)) this.waiting.set(machine.id, { lines: keys.map(({ line }) => line), keys, changed });
        throw new Error(changed
          ? `The SSH host key ${machine.name} presents to ${this.self} changed. Compare its fingerprint in Remote `
            + 'machines on the phone, and accept it there only if you know why it changed.'
          : `${this.self} doesn’t trust the SSH host key ${machine.name} presents yet. Compare its fingerprint in `
            + 'Remote machines on the phone, then accept it there.');
      }
      if (changed) await forgetHostKey(target);
      await acceptHostKey(target, pinned.map(({ line }) => line));
      return (await connectSsh(target)).connection;
    }
  }

  private listed(machine: Machine): boolean {
    return this.machines.some((listed) => listed.id === machine.id && endpoint(listed) === endpoint(machine));
  }

  /** What the latest attempt found of a machine that is still listed as it was tried. */
  private record(machine: Machine, error: unknown) {
    if (!this.listed(machine)) return;
    this.reach = { ...this.reach,
      [machine.id]: error === undefined ? { reachable: true } : { reachable: false, error: errorText(error) } };
    if (error === undefined) this.waiting.delete(machine.id);
    this.publish();
  }

  private publish() {
    this.pending = Object.fromEntries([...this.waiting].map(([id, { keys, changed }]) =>
      [id, { keys: keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })), changed }]));
    for (const listener of [...this.listeners]) listener();
  }
}
