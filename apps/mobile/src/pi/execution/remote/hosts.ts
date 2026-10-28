import type { SshHostKey } from '@osuki-dev/react-native-ssh';
import { machineEndpoint } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

export type RemoteCredential = Readonly<{ type: 'password'; password: string } |
  { type: 'privateKey'; privateKey: string; passphrase?: string }>;

/**
 * How this phone reaches a machine: its endpoint and the reference to the credential this phone keeps for it. The
 * machine's name, its keys and what the machines found of each other are the conversation's (the machines document,
 * `infinichat-remote/machines.ts`); the credential and the host key this phone trusts never leave this phone.
 */
export interface RemoteHost {
  /** The machine's endpoint (`machineEndpoint`), its ID everywhere. */
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly credentialRef: string;
  readonly credentialType: RemoteCredential['type'];
}
export type RemoteHostInput = Pick<RemoteHost, 'hostname' | 'port' | 'username'>;
export interface RemoteHostAdmission {
  readonly host: RemoteHost;
  readonly auth: RemoteCredential;
  readonly trustedHostKey?: Readonly<SshHostKey>;
}
export interface RemoteHostSnapshot {
  readonly ready: boolean;
  readonly hosts: readonly RemoteHost[];
  readonly error?: string;
  readonly cleanupError?: string;
}
/**
 * `legacy` maps the IDs version 1 gave the records to their endpoints, for the chats that chose a machine then: a
 * chat's execution target keeps that ID.
 */
interface HostIndex { version: 2; hosts: RemoteHost[]; pendingDelete: string[]; legacy: Record<string, string> }
interface SecretRecord { version: 1; auth: RemoteCredential; trustedHostKey?: SshHostKey }
/** InfiniChat lists the phone as a device under this name, beside the machines under theirs. */
export const PHONE_DEVICE = 'phone';
const INDEX_KEY = 'pi.remote-hosts.v1';
const CREDENTIAL_REF = /^pi\.ssh\.v1\.[a-zA-Z0-9._-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${label}.`);
  return value.trim();
}
export function validateRemoteHost(input: RemoteHostInput): RemoteHostInput {
  const hostname = text(input.hostname, 'Tailscale hostname or address').toLowerCase();
  if (/[\s/@?#\\]/.test(hostname)) throw new Error('Enter a Tailscale hostname or address without a URL prefix, username, or port.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH port must be a number from 1 to 65535.');
  return { hostname, port: input.port, username: text(input.username, 'SSH username') };
}
function credential(value: unknown): RemoteCredential {
  if (isRecord(value)) {
    const { type, password, privateKey, passphrase } = value;
    if (type === 'password' && typeof password === 'string' && password.length > 0) {
      return Object.freeze({ type: 'password', password });
    }
    if (type === 'privateKey' && typeof privateKey === 'string' && privateKey.trim() &&
        (passphrase === undefined || typeof passphrase === 'string')) {
      return Object.freeze({ type: 'privateKey', privateKey: privateKey.trim(),
        ...(passphrase ? { passphrase } : {}) });
    }
  }
  throw new Error('Enter an SSH password or private key.');
}
function hostKey(value: unknown): Readonly<SshHostKey> {
  if (isRecord(value)) {
    const { algorithm, fingerprint, publicKey } = value;
    if (typeof algorithm === 'string' && algorithm &&
        typeof fingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(fingerprint) &&
        typeof publicKey === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) {
      return Object.freeze({ algorithm, fingerprint, publicKey });
    }
  }
  throw new Error('The SSH server returned an invalid host key.');
}
export function matchesHostKey(trusted: Readonly<SshHostKey> | undefined, observed: SshHostKey): boolean {
  return !!trusted && trusted.algorithm === observed.algorithm && trusted.fingerprint === observed.fingerprint && trusted.publicKey === observed.publicKey;
}

/**
 * How every connection to the machine checks its SSH host key, as OpenSSH's `accept-new` does (owner decision,
 * 2026-10-27): the key the machine presents first is trusted and kept with its credentials, from then on only that
 * key connects, offered first, and a different one is refused (`HOST_KEY_REJECTED`), which Remote machines turns into
 * the choice to trust the new key.
 */
export function hostKeyPolicy(repository: RemoteHostRepository, { host, trustedHostKey }: RemoteHostAdmission): {
  hostKeyAlgorithms?: string[]; verifyHostKey(observed: SshHostKey): Promise<boolean>;
} {
  return {
    ...(trustedHostKey ? { hostKeyAlgorithms: [trustedHostKey.algorithm] } : {}),
    verifyHostKey: async (observed) => {
      if (trustedHostKey) return matchesHostKey(trustedHostKey, observed);
      await repository.acceptHostKey(host, observed);
      return true;
    },
  };
}

/** A record's fields that both versions store; version 1 also had a name and keys, which the document holds now. */
function storedFields(value: unknown): Omit<RemoteHost, 'id'> {
  if (!isRecord(value)) throw new Error();
  const { credentialRef, credentialType, hostname, port, username } = value;
  if (typeof credentialRef !== 'string' || !CREDENTIAL_REF.test(credentialRef) ||
      (credentialType !== 'password' && credentialType !== 'privateKey') ||
      typeof hostname !== 'string' || typeof port !== 'number' || typeof username !== 'string') throw new Error();
  return { ...validateRemoteHost({ hostname, port, username }), credentialRef, credentialType };
}
function hostIndex(raw: string): HostIndex {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !Array.isArray(parsed.hosts) || !Array.isArray(parsed.pendingDelete)) throw new Error();
  const pendingDelete = parsed.pendingDelete.map((ref: unknown) => {
    if (typeof ref !== 'string' || !CREDENTIAL_REF.test(ref)) throw new Error();
    return ref;
  });
  const hosts: RemoteHost[] = [];
  const legacy: Record<string, string> = {};
  if (parsed.version === 2) {
    if (!isRecord(parsed.legacy)) throw new Error();
    for (const [old, endpoint] of Object.entries(parsed.legacy)) {
      if (typeof endpoint !== 'string') throw new Error();
      legacy[old] = endpoint;
    }
  } else if (parsed.version !== 1) {
    throw new Error();
  }
  for (const value of parsed.hosts) {
    const fields = storedFields(value);
    const id = parsed.version === 1 ? machineEndpoint(fields) : isRecord(value) ? value.id : undefined;
    if (typeof id !== 'string' || !id) throw new Error();
    if (parsed.version === 1 && isRecord(value) && typeof value.id === 'string') legacy[value.id] = id;
    // Two version 1 records of one endpoint keep the first; the other's credential is retired.
    if (hosts.some((host) => host.id === id)) {
      pendingDelete.push(fields.credentialRef);
      continue;
    }
    hosts.push(Object.freeze({ ...fields, id }));
  }
  if (pendingDelete.some((ref) => hosts.some((host) => host.credentialRef === ref))) throw new Error();
  return { version: 2, hosts, pendingDelete, legacy };
}

/** Display metadata does not change an admitted connection; saved secret records are immutable. */
export function sameRemoteConnection(a: RemoteHost | undefined, b: RemoteHost): boolean {
  return !!a && a.id === b.id && a.hostname === b.hostname && a.port === b.port &&
    a.username === b.username && a.credentialRef === b.credentialRef;
}

/**
 * This phone's credentials for the machines, by endpoint. Settings reads are local and secret-free. Admission
 * returns an immutable copy; edits and removal affect future admissions, never a previously admitted session. A new
 * secure record is written before publishing its metadata reference. Old records are retired through a persisted
 * deletion queue, including after restart.
 */
export class RemoteHostRepository {
  private index: HostIndex = { version: 2, hosts: [], pendingDelete: [], legacy: {} };
  private snapshot: RemoteHostSnapshot = Object.freeze({ ready: false, hosts: Object.freeze([]) });
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly metadata: CredentialBackend, private readonly secrets: CredentialBackend,
    private readonly createId: () => string) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;
  /** The record at an endpoint, or the one a chat chose by the ID version 1 gave it. */
  get(id: string): RemoteHost | undefined {
    const endpoint = this.index.legacy[id] ?? id;
    return this.snapshot.hosts.find((host) => host.id === endpoint);
  }
  private publish(error?: string, cleanupError?: string) {
    this.snapshot = Object.freeze({ ready: true, hosts: Object.freeze([...this.index.hosts]), ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) });
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action);
    this.tail = result.catch(() => {});
    return result;
  }
  private async load() {
    if (this.snapshot.ready && !this.snapshot.error) return;
    let converted = false;
    try {
      const raw = await this.metadata.getItemAsync(INDEX_KEY);
      this.index = raw === null ? { version: 2, hosts: [], pendingDelete: [], legacy: {} } : hostIndex(raw);
      converted = raw !== null && !raw.includes('"version":2');
      this.publish();
    } catch {
      const message = 'Could not restore remote machines. Unlock this device and retry. Saved settings have been preserved.';
      this.publish(message);
      throw new Error(message);
    }
    // A version 1 index is written back in its new shape once.
    if (converted) await this.commit(this.index);
  }
  restore(): Promise<void> { return this.enqueue(async () => { await this.load(); await this.retireSecrets(); }); }
  private requireHost(id: string, expected?: RemoteHost): RemoteHost {
    const host = this.get(id);
    if (!host) throw new Error('This iPhone has no credentials for that machine. Add them in Remote machines.');
    if (expected && !sameRemoteConnection(host, expected)) throw new Error('This machine changed. Reopen its settings and try again.');
    return host;
  }
  private async readSecret(host: RemoteHost): Promise<SecretRecord> {
    try {
      const raw = await this.secrets.getItemAsync(host.credentialRef);
      if (!raw) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== 1) throw new Error();
      const auth = credential(parsed.auth);
      if (auth.type !== host.credentialType) throw new Error();
      return { version: 1, auth, ...(parsed.trustedHostKey ? { trustedHostKey: hostKey(parsed.trustedHostKey) } : {}) };
    } catch { throw new Error('Could not restore this machine’s SSH credentials. Unlock this device, or replace its credentials in Remote machines.'); }
  }
  admit(id: string, expectedHost?: RemoteHost): Promise<RemoteHostAdmission> {
    const expected = expectedHost && { ...expectedHost };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expected);
      const secret = await this.readSecret(host);
      return Object.freeze({ host, auth: secret.auth, ...(secret.trustedHostKey ? { trustedHostKey: secret.trustedHostKey } : {}) });
    });
  }
  private async commit(index: HostIndex) {
    try { await this.metadata.setItemAsync(INDEX_KEY, JSON.stringify(index)); }
    catch { throw new Error('Could not save remote machine settings. Try again.'); }
    this.index = index;
    this.publish();
  }
  private async retireSecrets() {
    if (!this.index.pendingDelete.length) return;
    try {
      for (const ref of this.index.pendingDelete) await this.secrets.deleteItemAsync(ref);
      await this.commit({ ...this.index, pendingDelete: [] });
    } catch {
      this.publish(undefined, 'Machine settings are saved, but retired SSH credentials could not be removed. Unlock this device and retry cleanup.');
    }
  }
  /** Writes `host` with a new secret record in place of `previous`, whose endpoint may differ. */
  private async replace(host: Omit<RemoteHost, 'credentialRef'>, secret: SecretRecord,
    previous: RemoteHost | undefined): Promise<RemoteHost> {
    const credentialRef = `pi.ssh.v1.${this.createId()}`;
    // Journal before writing the secure record, so a process crash between the
    // two stores cannot leave an untracked credential behind.
    await this.commit({ ...this.index, pendingDelete: [...this.index.pendingDelete, credentialRef] });
    try { await this.secrets.setItemAsync(credentialRef, JSON.stringify(secret)); }
    catch {
      await this.retireSecrets();
      throw new Error('Could not save SSH credentials securely. Unlock this device and try again.');
    }
    const next = Object.freeze({ ...host, credentialRef, credentialType: secret.auth.type });
    const hosts = [...this.index.hosts.filter((item) => item.id !== next.id && item.id !== previous?.id), next];
    try {
      await this.commit({ ...this.index, hosts,
        pendingDelete: [...this.index.pendingDelete.filter((ref) => ref !== credentialRef),
          ...(previous ? [previous.credentialRef] : [])] });
    } catch (error) {
      await this.retireSecrets();
      throw error;
    }
    await this.retireSecrets();
    return next;
  }
  /**
   * Keeps the credential for the machine at the input's endpoint, replacing `expectedHost`'s record, whose endpoint
   * may be another: a changed endpoint is another machine, with its own record.
   */
  save(input: RemoteHostInput, replacement?: RemoteCredential, expectedHost?: RemoteHost): Promise<RemoteHost> {
    // Capture mutable form data before enqueueing behind native storage I/O.
    const settings = validateRemoteHost(input);
    const id = machineEndpoint(settings);
    const expected = expectedHost && { ...expectedHost };
    const auth = replacement && credential(replacement);
    return this.enqueue(async () => {
      await this.load();
      const previous = expected ? this.requireHost(expected.id, expected) : undefined;
      if (previous && previous.id === id && !auth) return previous;
      const taken = previous?.id === id ? undefined : this.index.hosts.find((host) => host.id === id);
      if (taken) throw new Error(`${id} is already among your machines.`);
      let current: SecretRecord | undefined;
      if (previous) {
        try { current = await this.readSecret(previous); }
        catch (error) { if (!auth) throw error; /* Explicit credential replacement also resets unreadable host trust. */ }
      }
      const nextAuth = auth ?? current?.auth;
      if (!nextAuth) throw new Error('Enter an SSH password or private key.');
      // The trusted host key goes with the endpoint: another endpoint is another server to trust on first use.
      return this.replace({ ...settings, id, credentialType: nextAuth.type },
        { version: 1, auth: nextAuth,
          ...(previous?.id === id && current?.trustedHostKey ? { trustedHostKey: current.trustedHostKey } : {}) },
        previous);
    });
  }
  acceptHostKey(expectedHost: RemoteHost, observed: SshHostKey): Promise<RemoteHost> {
    const expected = { ...expectedHost };
    const accepted = hostKey(observed);
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(expected.id, expected);
      const secret = await this.readSecret(host);
      if (matchesHostKey(secret.trustedHostKey, accepted)) return host;
      return this.replace(host, { ...secret, trustedHostKey: accepted }, host);
    });
  }
  forgetHostKey(expectedHost: RemoteHost): Promise<RemoteHost> {
    const expected = { ...expectedHost };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(expected.id, expected);
      const { auth, trustedHostKey } = await this.readSecret(host);
      return trustedHostKey ? this.replace(host, { version: 1, auth }, host) : host;
    });
  }
  remove(id: string, expectedHost?: RemoteHost): Promise<void> {
    const expected = expectedHost && { ...expectedHost };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expected);
      const legacy = Object.fromEntries(Object.entries(this.index.legacy).filter(([, endpoint]) => endpoint !== host.id));
      await this.commit({ version: 2, hosts: this.index.hosts.filter((item) => item.id !== host.id),
        pendingDelete: [...this.index.pendingDelete, host.credentialRef], legacy });
      await this.retireSecrets();
    });
  }
}
