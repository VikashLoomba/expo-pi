import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  acceptHostKey, connectSsh, detectPlatform, forgetHostKey, HostKeyChangedError, HostKeyUnknownError,
  RemoteExecutionEnv, scanHostKey, type Connection, type RemotePlatform, type SshTarget,
} from '@earendil-works/pi-env';
import {
  machineEndpoint, type InfiniChatClient, type Machine,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { MachineDirectory } from '@pi-agent/infinichat/pi/infinichat-remote/dialer';
import {
  forgetSecret, machineIdentity, removeClient, savedSecret,
} from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { isSshKeyBlob, keyBlob, keyExchangeLines } from '@pi-agent/infinichat/pi/infinichat-remote/keys';
import { PRINT_MARKER, runScript } from '@pi-agent/infinichat/pi/infinichat-remote/machine';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import type { ShownInfiniChat } from '@pi-agent/infinichat/pi/shown-infinichat';
import { PATHS, Utils } from 'electrobun/main';

import type { Check } from '../contract';
import { writeSettings, type Settings } from './settings';

/** The ID of this Mac in the app's home record, which names it from the first launch. */
export const THIS_MAC = 'mac';

/** This Mac as a machine: its name, its host name and the account the app runs as. */
export interface MacMachine {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
}

export const thisMac = (name: string): MacMachine =>
  ({ id: THIS_MAC, name, hostname: hostname(), port: 22, username: userInfo().username });

const noop = () => {};
/** The lines of a scan with their fingerprints, as `ServerMachines` reads them (`node/machines.ts`). */
interface Scanned { line: string; algorithm: string; fingerprint: string }
const scanned = (name: string, scan: { lines: string[]; fingerprints: string[] }): Scanned[] => {
  if (scan.lines.length !== scan.fingerprints.length) throw new Error(`The SSH host key of ${name} could not be read.`);
  return scan.lines.map((line, index) => ({
    line, algorithm: line.split(/\s+/)[1] ?? '', fingerprint: scan.fingerprints[index].split(/\s+/)[1] ?? '',
  }));
};
const without = <T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([entry]) => entry !== key));

/**
 * The conversation's machines as this Mac reaches them: the document through the shown side, as the phone reads
 * it, and this Mac's own way to each machine over pi-env with the user's SSH setup or a chosen identity file
 * (deviation 4), trusting host keys on first use as the server does (`node/machines.ts`). A check connects, names
 * the machine, exchanges the InfiniChat keys (`keys.ts`) and records what it found on the document. The connections
 * are pooled for the dialer and the moves of piece 5 and closed at quit.
 */
export class MacMachines {
  private readonly connections = new Map<string, Promise<Connection>>();
  private readonly running = new Map<string, AbortController>();
  /** The scans waiting for Trust new key, whose lines it trusts. */
  private readonly waiting = new Map<string, { keys: Scanned[]; changed: boolean }>();
  private checks: Record<string, Check> = {};
  private readonly listeners = new Set<() => void>();
  private readonly knownHosts: string;
  private closed = false;

  constructor(private readonly shown: ShownInfiniChat, private readonly client: InfiniChatClient,
    private readonly secrets: CredentialBackend, private readonly self: MacMachine,
    private readonly settings: Settings) {
    this.knownHosts = join(Utils.paths.userData, 'known_hosts');
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getChecks = () => this.checks;
  readonly getIdentities = (): Record<string, string> => this.settings.identities ?? {};
  /** This Mac's endpoint among the machines: the record under its name, or the one it would put. */
  readonly getSelf = (): string => {
    const listed = Object.entries(this.shown.machines.getSnapshot()?.machines ?? {})
      .find(([, machine]) => machine.name === this.self.name);
    return listed?.[0] ?? machineEndpoint(this.self);
  };

  /** The record this Mac lists itself under: by the name it goes by, which the phone's check gave it too. */
  record(): Machine {
    const listed = this.shown.machines.getSnapshot()?.machines[this.getSelf()];
    const { name, hostname: host, port, username } = this.self;
    return listed ?? { name, hostname: host, port, username };
  }

  /** Lists this Mac once the document is readable and has no record under its name. */
  putSelf(): void {
    const listed = this.shown.machines.getSnapshot();
    if (listed === undefined || listed.machines[this.getSelf()] !== undefined) return;
    void this.shown.putMachine(this.record()).catch(noop);
  }

  /** Adds a machine, or replaces the record a changed endpoint leaves, and names it by its host until a check. */
  async save(form: { hostname: string; port: number; username: string; previous?: string }): Promise<void> {
    const hostnameText = form.hostname.trim().toLowerCase();
    if (!hostnameText || /[\s/@?#\\]/.test(hostnameText)) {
      throw new Error('Enter a host name or address without a URL prefix, username, or port.');
    }
    if (!Number.isInteger(form.port) || form.port < 1 || form.port > 65535) {
      throw new Error('SSH port must be a number from 1 to 65535.');
    }
    const username = form.username.trim();
    if (!username) throw new Error('Enter the SSH username.');
    const record = { hostname: hostnameText, port: form.port, username };
    const endpoint = machineEndpoint(record);
    const listed = this.shown.machines.getSnapshot()?.machines;
    const previous = form.previous === undefined ? undefined : listed?.[form.previous];
    if (form.previous !== undefined && form.previous !== endpoint && previous !== undefined) {
      await this.shown.removeMachine(form.previous);
      this.drop(form.previous);
      const identity = this.getIdentities()[form.previous];
      this.setIdentity(form.previous, null);
      if (identity !== undefined) this.setIdentity(endpoint, identity);
    }
    if (listed?.[endpoint] === undefined) {
      await this.shown.putMachine({ name: previous?.name ?? record.hostname, ...record });
    }
  }

  /** Removes the machine from the conversation (the window confirms), and this Mac's client file there. */
  async remove(endpoint: string): Promise<void> {
    const machine = this.shown.machines.getSnapshot()?.machines[endpoint];
    if (machine === undefined) throw new Error('That machine is no longer among the machines.');
    if (endpoint === this.getSelf()) throw new Error('Move InfiniChat to another machine first.');
    this.cancelCheck(endpoint);
    if (await savedSecret(this.secrets, endpoint) !== undefined) {
      const signal = AbortSignal.timeout(20_000);
      await this.environment(endpoint, signal).then((env) => removeClient(env, this.client.id)).catch(noop);
      await forgetSecret(this.secrets, endpoint).catch(noop);
    }
    await this.shown.removeMachine(endpoint);
    this.drop(endpoint);
    this.waiting.delete(endpoint);
    this.checks = without(this.checks, endpoint);
    this.setIdentity(endpoint, null);
    this.publish();
  }

  /** Connects to the machine, names it, exchanges the InfiniChat keys and records what it found. */
  check(endpoint: string): void {
    if (this.running.has(endpoint)) return;
    const controller = new AbortController();
    this.running.set(endpoint, controller);
    this.checks = { ...this.checks, [endpoint]: { stage: 'connecting' } };
    this.publish();
    void this.run(endpoint, controller.signal).then((result) => {
      this.checks = { ...this.checks, [endpoint]: { result } };
    }, (error: unknown) => {
      const pending = this.waiting.get(endpoint);
      this.checks = { ...this.checks, [endpoint]: {
        error: controller.signal.aborted ? 'Connection check cancelled.'
          : error instanceof Error ? error.message : String(error),
        ...(pending === undefined ? {} : { pendingKey: { changed: pending.changed,
          keys: pending.keys.map(({ algorithm, fingerprint }) => ({ algorithm, fingerprint })) } }),
      } };
    }).finally(() => {
      if (this.running.get(endpoint) === controller) this.running.delete(endpoint);
      this.publish();
    });
  }

  cancelCheck(endpoint: string): void {
    this.running.get(endpoint)?.abort();
  }

  /** Lets go of the key trusted for the machine and checks it again, which trusts the one it presents now. */
  async trustNewKey(endpoint: string): Promise<void> {
    const machine = this.shown.machines.getSnapshot()?.machines[endpoint];
    if (machine === undefined) throw new Error('That machine is no longer among the machines.');
    this.drop(endpoint);
    await forgetHostKey(this.target(machine));
    this.waiting.delete(endpoint);
    this.check(endpoint);
  }

  setIdentity(endpoint: string, path: string | null): void {
    const identities = this.getIdentities();
    this.settings.identities = path === null ? without(identities, endpoint) : { ...identities, [endpoint]: path };
    writeSettings(this.settings);
    this.drop(endpoint);
    this.publish();
  }

  /** The identity file chosen in the open dialog; null when the user cancels. */
  async pickIdentityFile(): Promise<string | null> {
    const [path] = await Utils.openFileDialog({
      canChooseFiles: true, canChooseDirectory: false, allowsMultipleSelection: false,
    });
    return path ?? null;
  }

  /** A machine's files and commands over this Mac's own SSH, for a check, a removal and piece 5's moves. */
  async environment(endpoint: string, signal: AbortSignal): Promise<RemoteExecutionEnv> {
    const machine = this.shown.machines.getSnapshot()?.machines[endpoint];
    if (machine === undefined) throw new Error('That machine is no longer among the machines.');
    const connection = await this.started(machine, signal);
    const info = await connection.info();
    return new RemoteExecutionEnv({ connection, id: `pi-env:${endpoint}`, cwd: info.home });
  }

  /** At quit, after the InfiniChat clients: stops each machine's daemon, also one still connecting. */
  close(): void {
    this.closed = true;
    for (const controller of this.running.values()) controller.abort();
    for (const key of [...this.connections.keys()]) this.drop(key);
  }

  private async run(endpoint: string, signal: AbortSignal): Promise<NonNullable<Check['result']>> {
    const machine = this.shown.machines.getSnapshot()?.machines[endpoint];
    if (machine === undefined) throw new Error('That machine is no longer among the machines.');
    const connection = await this.started(machine, signal);
    signal.throwIfAborted();
    this.stage(endpoint, 'checking');
    const info = await connection.info();
    if (info.separator !== '/' || info.os === 'windows') throw new Error('Unsupported remote operating system.');
    const env = new RemoteExecutionEnv({ connection, id: `pi-env:${endpoint}`, cwd: info.home });
    const identity = await machineIdentity(env, machine.name, signal);
    this.stage(endpoint, 'exchanging');
    // The other machines' InfiniChat keys go into its authorized_keys, as the phone's check puts them.
    const others = Object.values(this.shown.machines.getSnapshot()?.machines ?? {})
      .flatMap((other) => machineEndpoint(other) !== endpoint && other.publicKey !== undefined
        ? [other.publicKey] : []);
    const [status, key] = await runScript(env, signal, identity.name, keyExchangeLines(others, PRINT_MARKER),
      { failure: `${identity.name} could not set up its InfiniChat key. Check ssh-keygen and its home folder.` });
    if (status === 'unwritable') {
      throw new Error(`The SSH account on ${identity.name} can neither write nor read its ~/.ssh/authorized_keys, `
        + 'so the other machines’ keys can’t be authorized there. Make that file the account’s own, then try '
        + 'again.');
    }
    const publicKey = keyBlob(key ?? '');
    if (status !== 'ok' || !isSshKeyBlob(publicKey)) {
      throw new Error(`${identity.name}’s InfiniChat key could not be read.`);
    }
    await this.shown.patchMachine(endpoint, { name: identity.name, publicKey, authorizedKeys: [...others].sort() });
    return { version: info.version, os: info.os, arch: info.arch, name: identity.name };
  }

  private stage(endpoint: string, stage: NonNullable<Check['stage']>) {
    this.checks = { ...this.checks, [endpoint]: { stage } };
    this.publish();
  }

  /**
   * How this Mac's `ssh` reaches the machine: the user's own setup unless an identity file was chosen (pi-env then
   * sets `IdentitiesOnly`), checking the host key against the keys trusted here under its endpoint.
   */
  private target(machine: Machine): SshTarget {
    const identity = this.getIdentities()[machineEndpoint(machine)];
    return { host: machine.hostname, port: machine.port, user: machine.username, knownHostsFile: this.knownHosts,
      hostKeyAlias: machineEndpoint(machine).toLowerCase(),
      ...(identity === undefined ? {} : { identityFile: identity }) };
  }

  /** The daemon this app ships for the machine, among its resources (`server-assets.ts`). */
  private daemon(remote: RemotePlatform): string {
    if (remote.platform !== 'darwin' && remote.platform !== 'linux') {
      throw new Error(`${remote.platform} machines are not supported.`);
    }
    return join(PATHS.RESOURCES_FOLDER, 'app', 'server', 'pi-env',
      `pi-env-${remote.platform}-${remote.arch}.bin`);
  }

  private drop(key: string) {
    const opening = this.connections.get(key);
    this.connections.delete(key);
    void opening?.then((connection) => connection.close(), noop);
  }

  /** Its connection, started; the pool keeps it for the next use. */
  private started(machine: Machine, signal: AbortSignal): Promise<Connection> {
    if (this.closed) throw new Error('InfiniChat is quitting.');
    const key = machineEndpoint(machine);
    let opening = this.connections.get(key);
    if (opening === undefined) {
      opening = this.open(machine, signal);
      this.connections.set(key, opening);
      opening.catch(() => {
        if (this.connections.get(key) === opening) this.connections.delete(key);
      });
    }
    return opening;
  }

  /** `connectSsh` with the daemon this app ships, trusting the machine's host key on first use. */
  private async open(machine: Machine, signal: AbortSignal): Promise<Connection> {
    const target = this.target(machine);
    const connect = async () => {
      const remote = await detectPlatform(target);
      signal.throwIfAborted();
      return (await connectSsh({ ...target, binary: this.daemon(remote), loginShell: true })).connection;
    };
    try {
      return await connect();
    } catch (error) {
      if (!(error instanceof HostKeyUnknownError) && !(error instanceof HostKeyChangedError)) throw error;
      const changed = error instanceof HostKeyChangedError;
      const keys = scanned(machine.name, await scanHostKey(target));
      if (changed) {
        this.waiting.set(machineEndpoint(machine), { keys, changed });
        throw new Error(`The SSH host key ${machine.name} presents changed since it was trusted here. Trust the new `
          + 'key only if you reinstalled or replaced the machine.');
      }
      await acceptHostKey(target, keys.map(({ line }) => line));
      return connect();
    }
  }

  private publish() {
    for (const listener of [...this.listeners]) listener();
  }
}

/** This Mac as `RemoteInfiniChat` knows it: its record among the machines, by the name it goes by. */
export function macDirectory(machines: MacMachines): MachineDirectory {
  return {
    id: THIS_MAC,
    machine: () => machines.record(),
    subscribe: machines.subscribe,
  };
}
