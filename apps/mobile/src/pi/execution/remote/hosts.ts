import type { SshHostKey } from '@osuki-dev/react-native-ssh';
import { isSshKeyBlob } from '@pi-agent/infinichat/pi/infinichat-remote/keys';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

export type RemoteCredential = Readonly<{ type: 'password'; password: string } |
  { type: 'privateKey'; privateKey: string; passphrase?: string }>;

/** Public machine settings. Credentials and accepted keys never enter this record. */
export interface RemoteHost {
  readonly id: string;
  /** Opaque filesystem identity; changes when the endpoint, account, or accepted server changes. */
  readonly namespaceId: string;
  readonly name: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly credentialRef: string;
  readonly credentialType: RemoteCredential['type'];
  /** The machine's own InfiniChat SSH key, as `ssh-keys.ts` read it: its type and base64, without a comment. */
  readonly publicKey?: string;
  /** The other machines' InfiniChat keys this phone authorized there, in the same form. */
  readonly authorizedKeys?: readonly string[];
}
export type RemoteHostInput = Omit<RemoteHost, 'id' | 'namespaceId' | 'credentialRef' | 'credentialType' | 'publicKey'
  | 'authorizedKeys'> & { id?: string };
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
interface HostIndex { version: 1; hosts: RemoteHost[]; pendingDelete: string[] }
interface SecretRecord { version: 1; auth: RemoteCredential; trustedHostKey?: SshHostKey }
/** InfiniChat lists the phone as a device under this name, beside the remote machines under theirs. */
export const PHONE_DEVICE = 'phone';
const INDEX_KEY = 'pi.remote-hosts.v1';
const CREDENTIAL_REF = /^pi\.ssh\.v1\.[a-zA-Z0-9._-]+$/;

/** A machine's InfiniChat keys, which stay with its account on its endpoint. */
const keysOf = ({ publicKey, authorizedKeys }: RemoteHost) => ({
  ...(publicKey === undefined ? {} : { publicKey }), ...(authorizedKeys === undefined ? {} : { authorizedKeys }),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${label}.`);
  return value.trim();
}
export function validateRemoteHost(input: RemoteHostInput): Omit<RemoteHostInput, 'id'> {
  const hostname = text(input.hostname, 'Tailscale hostname or address').toLowerCase();
  if (/[\s/@?#\\]/.test(hostname)) throw new Error('Enter a Tailscale hostname or address without a URL prefix, username, or port.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH port must be a number from 1 to 65535.');
  const name = text(input.name, 'machine name');
  if (name.toLowerCase() === PHONE_DEVICE) {
    throw new Error(`“${PHONE_DEVICE}” is this phone in InfiniChat. Choose another machine name.`);
  }
  return { name, hostname, port: input.port, username: text(input.username, 'SSH username') };
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

function storedHost(value: unknown): RemoteHost {
  if (!isRecord(value)) throw new Error();
  const { id, namespaceId, credentialRef, credentialType, name, hostname, port, username, publicKey, authorizedKeys }
    = value;
  if (typeof id !== 'string' || !id || typeof namespaceId !== 'string' || !namespaceId ||
      typeof credentialRef !== 'string' || !CREDENTIAL_REF.test(credentialRef) ||
      (credentialType !== 'password' && credentialType !== 'privateKey') ||
      typeof name !== 'string' || typeof hostname !== 'string' || typeof port !== 'number' ||
      typeof username !== 'string') throw new Error();
  if (publicKey !== undefined && !isSshKeyBlob(publicKey)) throw new Error();
  if (authorizedKeys !== undefined && (!Array.isArray(authorizedKeys) || !authorizedKeys.every(isSshKeyBlob))) {
    throw new Error();
  }
  return Object.freeze({ ...validateRemoteHost({ name, hostname, port, username }), id, namespaceId, credentialRef,
    credentialType, ...(publicKey === undefined ? {} : { publicKey }),
    ...(authorizedKeys === undefined ? {} : { authorizedKeys: Object.freeze([...authorizedKeys]) }) });
}
function hostIndex(raw: string): HostIndex {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.hosts) ||
      !Array.isArray(parsed.pendingDelete)) throw new Error();
  const ids = new Set<string>();
  const hosts = parsed.hosts.map((value: unknown) => {
    const host = storedHost(value);
    if (ids.has(host.id)) throw new Error();
    ids.add(host.id);
    return host;
  });
  const pendingDelete = parsed.pendingDelete.map((ref: unknown) => {
    if (typeof ref !== 'string' || !CREDENTIAL_REF.test(ref) || hosts.some((host) => host.credentialRef === ref)) {
      throw new Error();
    }
    return ref;
  });
  return { version: 1, hosts, pendingDelete };
}

/** Display metadata does not change an admitted connection; saved secret records are immutable. */
export function sameRemoteConnection(a: RemoteHost | undefined, b: RemoteHost): boolean {
  return !!a && a.id === b.id && a.hostname === b.hostname && a.port === b.port &&
    a.username === b.username && a.credentialRef === b.credentialRef;
}

/**
 * Settings reads are local and secret-free. Admission returns an immutable copy;
 * edits and removal affect future admissions, never a previously admitted session.
 * A new secure record is written before publishing its metadata reference. Old
 * records are retired through a persisted deletion queue, including after restart.
 */
export class RemoteHostRepository {
  private index: HostIndex = { version: 1, hosts: [], pendingDelete: [] };
  private snapshot: RemoteHostSnapshot = Object.freeze({ ready: false, hosts: Object.freeze([]) });
  private readonly listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly metadata: CredentialBackend, private readonly secrets: CredentialBackend,
    private readonly createId: () => string) {}

  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getSnapshot = () => this.snapshot;
  get(id: string): RemoteHost | undefined { return this.snapshot.hosts.find((host) => host.id === id); }
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
    try {
      const raw = await this.metadata.getItemAsync(INDEX_KEY);
      this.index = raw === null ? { version: 1, hosts: [], pendingDelete: [] } : hostIndex(raw);
      this.publish();
    } catch {
      const message = 'Could not restore remote machines. Unlock this device and retry. Saved settings have been preserved.';
      this.publish(message);
      throw new Error(message);
    }
  }
  restore(): Promise<void> { return this.enqueue(async () => { await this.load(); await this.retireSecrets(); }); }
  private requireHost(id: string, expected?: RemoteHost): RemoteHost {
    const host = this.get(id);
    if (!host) throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
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
  private async replace(host: RemoteHost, secret: SecretRecord): Promise<RemoteHost> {
    const credentialRef = `pi.ssh.v1.${this.createId()}`;
    // Journal before writing the secure record, so a process crash between the
    // two stores cannot leave an untracked credential behind.
    await this.commit({ ...this.index, pendingDelete: [...this.index.pendingDelete, credentialRef] });
    try { await this.secrets.setItemAsync(credentialRef, JSON.stringify(secret)); }
    catch {
      await this.retireSecrets();
      throw new Error('Could not save SSH credentials securely. Unlock this device and try again.');
    }
    const previous = this.get(host.id);
    const next = Object.freeze({ ...host, credentialRef, credentialType: secret.auth.type });
    const hosts = previous ? this.index.hosts.map((item) => item.id === next.id ? next : item) : [...this.index.hosts, next];
    try {
      await this.commit({ version: 1, hosts, pendingDelete: [...this.index.pendingDelete.filter((ref) => ref !== credentialRef), ...(previous ? [previous.credentialRef] : [])] });
    } catch (error) {
      await this.retireSecrets();
      throw error;
    }
    await this.retireSecrets();
    return next;
  }
  save(input: RemoteHostInput, replacement?: RemoteCredential, expectedHost?: RemoteHost): Promise<RemoteHost> {
    // Capture mutable form data before enqueueing behind native storage I/O.
    const settings = validateRemoteHost(input);
    const id = input.id;
    const expected = expectedHost && { ...expectedHost };
    const auth = replacement && credential(replacement);
    return this.enqueue(async () => {
      await this.load();
      const previous = id ? this.requireHost(id, expected) : undefined;
      // InfiniChat's tools name the machine they run on, so no two machines share a name.
      const taken = this.index.hosts.find((host) =>
        host.id !== id && host.name.toLowerCase() === settings.name.toLowerCase());
      if (taken) throw new Error(`Another machine is already named ${taken.name}. Choose another machine name.`);
      const sameEndpoint = previous?.hostname === settings.hostname && previous?.port === settings.port;
      if (previous && sameEndpoint && !auth) {
        // Name/account edits do not rewrite unchanged credentials or server trust.
        const next = Object.freeze({ ...previous, ...settings,
          namespaceId: previous.username === settings.username ? previous.namespaceId : this.createId() });
        await this.commit({ ...this.index, hosts: this.index.hosts.map((host) => host.id === id ? next : host) });
        await this.retireSecrets();
        return next;
      }
      let current: SecretRecord | undefined;
      if (previous) {
        try { current = await this.readSecret(previous); }
        catch (error) { if (!auth) throw error; /* Explicit credential replacement also resets unreadable host trust. */ }
      }
      const nextAuth = auth ?? current?.auth;
      if (!nextAuth) throw new Error('Enter an SSH password or private key.');
      return this.replace({ ...settings, id: previous?.id ?? this.createId(),
        namespaceId: sameEndpoint && previous?.username === settings.username ? previous.namespaceId : this.createId(),
        credentialRef: '', credentialType: nextAuth.type,
        ...(sameEndpoint && previous?.username === settings.username ? keysOf(previous) : {}) },
      { version: 1, auth: nextAuth,
        ...(sameEndpoint && current?.trustedHostKey ? { trustedHostKey: current.trustedHostKey } : {}) });
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
      return this.replace({ ...host, namespaceId: this.createId() }, { ...secret, trustedHostKey: accepted });
    });
  }
  /**
   * Keeps the key `ssh-keys.ts` gave the machine and the others' keys it authorized there; a repeat changes nothing.
   * The keys live with the account on the machine, so a credential or host key replaced meanwhile, as a first test
   * accepting the host key does, doesn't lose them.
   */
  setKeys(expectedHost: RemoteHost,
    keys: { publicKey: string; authorizedKeys: readonly string[] }): Promise<RemoteHost> {
    const expected = { ...expectedHost };
    const next = { publicKey: keys.publicKey, authorizedKeys: Object.freeze([...keys.authorizedKeys].sort()) };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(expected.id);
      if (host.hostname !== expected.hostname || host.port !== expected.port || host.username !== expected.username) {
        throw new Error('This machine changed. Test it again.');
      }
      if (host.publicKey === next.publicKey
        && JSON.stringify(host.authorizedKeys) === JSON.stringify(next.authorizedKeys)) return host;
      const updated = Object.freeze({ ...host, ...next });
      await this.commit({ ...this.index, hosts: this.index.hosts.map((item) => item.id === host.id ? updated : item) });
      return updated;
    });
  }
  forgetHostKey(expectedHost: RemoteHost): Promise<RemoteHost> {
    const expected = { ...expectedHost };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(expected.id, expected);
      const { auth, trustedHostKey } = await this.readSecret(host);
      return trustedHostKey ? this.replace(host, { version: 1, auth }) : host;
    });
  }
  remove(id: string, expectedHost?: RemoteHost): Promise<void> {
    const expected = expectedHost && { ...expectedHost };
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expected);
      await this.commit({ version: 1, hosts: this.index.hosts.filter((item) => item.id !== id),
        pendingDelete: [...this.index.pendingDelete, host.credentialRef] });
      await this.retireSecrets();
    });
  }
}
