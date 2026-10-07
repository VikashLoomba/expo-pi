import type { SshHostKey } from '@osuki-dev/react-native-ssh';

import type { CredentialBackend } from '../../codex-auth/credential-store';

export type RemoteCredential = Readonly<{ type: 'password'; password: string } |
  { type: 'privateKey'; privateKey: string; passphrase?: string }>;

/** Public machine settings. Credentials and accepted keys never enter this record. */
export interface RemoteHost {
  readonly id: string;
  readonly revision: number;
  /** Opaque filesystem identity; changes when the endpoint, account, or accepted server changes. */
  readonly namespaceId: string;
  readonly name: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly credentialRef: string;
  readonly credentialType: RemoteCredential['type'];
}
export type RemoteHostInput = Omit<RemoteHost, 'id' | 'revision' | 'namespaceId' | 'credentialRef' | 'credentialType'> &
  { id?: string; revision?: number };
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
const INDEX_KEY = 'pi.remote-hosts.v1';

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Enter a valid ${label}.`);
  return value.trim();
}
export function validateRemoteHost(input: RemoteHostInput): Omit<RemoteHostInput, 'id' | 'revision'> {
  const hostname = text(input.hostname, 'Tailscale hostname or address').toLowerCase();
  if (/[\s/@?#\\]/.test(hostname)) throw new Error('Enter a Tailscale hostname or address without a URL prefix, username, or port.');
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH port must be a number from 1 to 65535.');
  return { name: text(input.name, 'machine name'), hostname, port: input.port,
    username: text(input.username, 'SSH username') };
}
function credential(value: RemoteCredential): RemoteCredential {
  if (value?.type === 'password' && typeof value.password === 'string' && value.password.length > 0) {
    return Object.freeze({ type: 'password', password: value.password });
  }
  if (value?.type === 'privateKey' && typeof value.privateKey === 'string' && value.privateKey.trim() &&
      (value.passphrase === undefined || typeof value.passphrase === 'string')) {
    return Object.freeze({ type: 'privateKey', privateKey: value.privateKey.trim(),
      ...(value.passphrase ? { passphrase: value.passphrase } : {}) });
  }
  throw new Error('Enter an SSH password or private key.');
}
function hostKey(value: SshHostKey): Readonly<SshHostKey> {
  if (!value || typeof value.algorithm !== 'string' || !value.algorithm ||
      typeof value.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]+={0,2}$/.test(value.fingerprint) ||
      typeof value.publicKey !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.publicKey)) throw new Error('The SSH server returned an invalid host key.');
  return Object.freeze({ algorithm: value.algorithm, fingerprint: value.fingerprint, publicKey: value.publicKey });
}
export function matchesHostKey(trusted: Readonly<SshHostKey> | undefined, observed: SshHostKey): boolean {
  return !!trusted && trusted.algorithm === observed.algorithm && trusted.fingerprint === observed.fingerprint && trusted.publicKey === observed.publicKey;
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
      const parsed = raw === null ? { version: 1, hosts: [], pendingDelete: [] } : JSON.parse(raw);
      if (parsed.version !== 1 || !Array.isArray(parsed.hosts) || !Array.isArray(parsed.pendingDelete)) throw new Error();
      const ids = new Set<string>();
      const hosts = parsed.hosts.map((host: RemoteHost) => {
        if (typeof host.id !== 'string' || !host.id || ids.has(host.id) || !Number.isSafeInteger(host.revision) || host.revision < 1 ||
            typeof host.namespaceId !== 'string' || !host.namespaceId ||
            typeof host.credentialRef !== 'string' || !/^pi\.ssh\.v1\.[a-zA-Z0-9._-]+$/.test(host.credentialRef) ||
            !['password', 'privateKey'].includes(host.credentialType)) throw new Error();
        ids.add(host.id);
        // Project connection settings explicitly; obsolete working-directory
        // and daemon-path fields have no effect on restored machines.
        return Object.freeze({ ...validateRemoteHost(host), id: host.id, revision: host.revision,
          namespaceId: host.namespaceId, credentialRef: host.credentialRef, credentialType: host.credentialType });
      });
      if (parsed.pendingDelete.some((ref: unknown) => typeof ref !== 'string' || !/^pi\.ssh\.v1\.[a-zA-Z0-9._-]+$/.test(ref) ||
          hosts.some((host: RemoteHost) => host.credentialRef === ref))) throw new Error();
      this.index = { version: 1, hosts, pendingDelete: parsed.pendingDelete };
      this.publish();
    } catch {
      const message = 'Could not restore remote machines. Unlock this device and retry. Saved settings have been preserved.';
      this.publish(message);
      throw new Error(message);
    }
  }
  restore(): Promise<void> { return this.enqueue(async () => { await this.load(); await this.retireSecrets(); }); }
  private requireHost(id: string, expectedRevision?: number): RemoteHost {
    const host = this.get(id);
    if (!host) throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
    if (expectedRevision !== undefined && host.revision !== expectedRevision) throw new Error('This machine changed. Reopen its settings and try again.');
    return host;
  }
  private async readSecret(host: RemoteHost): Promise<SecretRecord> {
    try {
      const raw = await this.secrets.getItemAsync(host.credentialRef);
      if (!raw) throw new Error();
      const parsed = JSON.parse(raw);
      if (parsed.version !== 1) throw new Error();
      const auth = credential(parsed.auth);
      if (auth.type !== host.credentialType) throw new Error();
      return { version: 1, auth, ...(parsed.trustedHostKey ? { trustedHostKey: hostKey(parsed.trustedHostKey) } : {}) };
    } catch { throw new Error('Could not restore this machine’s SSH credentials. Unlock this device, or replace its credentials in Remote machines.'); }
  }
  admit(id: string, expectedRevision?: number): Promise<RemoteHostAdmission> {
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expectedRevision);
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
  save(input: RemoteHostInput, replacement?: RemoteCredential): Promise<RemoteHost> {
    // Capture mutable form data before enqueueing behind native storage I/O.
    const settings = validateRemoteHost(input);
    const id = input.id;
    const expectedRevision = input.revision;
    const auth = replacement && credential(replacement);
    return this.enqueue(async () => {
      await this.load();
      const previous = id ? this.requireHost(id, expectedRevision) : undefined;
      let current: SecretRecord | undefined;
      if (previous) {
        try { current = await this.readSecret(previous); }
        catch (error) { if (!auth) throw error; /* Explicit credential replacement also resets unreadable host trust. */ }
      }
      const nextAuth = auth ?? current?.auth;
      if (!nextAuth) throw new Error('Enter an SSH password or private key.');
      const sameEndpoint = previous?.hostname === settings.hostname && previous?.port === settings.port;
      return this.replace({ ...settings, id: previous?.id ?? this.createId(), revision: (previous?.revision ?? 0) + 1,
        namespaceId: sameEndpoint && previous?.username === settings.username ? previous.namespaceId : this.createId(),
        credentialRef: '', credentialType: nextAuth.type }, { version: 1, auth: nextAuth,
        ...(sameEndpoint && current?.trustedHostKey ? { trustedHostKey: current.trustedHostKey } : {}) });
    });
  }
  acceptHostKey(id: string, expectedRevision: number, observed: SshHostKey): Promise<RemoteHost> {
    const accepted = hostKey(observed);
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expectedRevision);
      const secret = await this.readSecret(host);
      return this.replace({ ...host, revision: host.revision + 1,
        namespaceId: matchesHostKey(secret.trustedHostKey, accepted) ? host.namespaceId : this.createId() }, { ...secret, trustedHostKey: accepted });
    });
  }
  forgetHostKey(id: string, expectedRevision: number): Promise<RemoteHost> {
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expectedRevision);
      const { auth } = await this.readSecret(host);
      return this.replace({ ...host, revision: host.revision + 1 }, { version: 1, auth });
    });
  }
  remove(id: string, expectedRevision?: number): Promise<void> {
    return this.enqueue(async () => {
      await this.load();
      const host = this.requireHost(id, expectedRevision);
      await this.commit({ version: 1, hosts: this.index.hosts.filter((item) => item.id !== id),
        pendingDelete: [...this.index.pendingDelete, host.credentialRef] });
      await this.retireSecrets();
    });
  }
}
