import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

import type { CredentialBackend, CredentialSnapshot, ObservableCredentialStore } from './codex-auth/credential-store';
import { CODEX_PROVIDER_ID } from './codex-auth/identity';

export interface ProviderAccess { ready: boolean; connected: boolean; type?: Credential['type']; error?: string }
/** Protocol adapters identify completed token rotation and terminal authentication failures. */
export interface ProviderCredentialPolicy {
  validate?(credential: Credential): void;
  isCompletedRefresh?(value: unknown): boolean;
  isPermanentAuthError?(error: unknown): boolean;
}
interface ProviderRecord { credential?: Credential; pendingCredential?: Credential; loaded: boolean; access: ProviderAccess }
interface ProviderCredentialSnapshot extends CredentialSnapshot { providers: Readonly<Record<string, ProviderAccess>> }
const EMPTY_ACCESS: ProviderAccess = { ready: false, connected: false };

export function providerCredentialKey(providerId: string) {
  // Keep the existing key namespace so saved API keys remain available after upgrade.
  return `pi.provider.api-key.v1.${Array.from(providerId, (character) => character.codePointAt(0)!.toString(16)).join('-')}`;
}

function copyJson(value: unknown, parents = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || parents.has(value)) throw new Error('Invalid credential data.');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error('Invalid credential data.');
  }
  parents.add(value);
  const result = Array.isArray(value)
    ? Array.from(value, (item) => copyJson(item, parents))
    : Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, copyJson(item, parents)]));
  parents.delete(value);
  return result;
}

function copyCredential(value: unknown): Credential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credential.');
  const candidate = value as Record<string, unknown>;
  if (candidate.type === 'api_key') {
    if (candidate.key !== undefined && (typeof candidate.key !== 'string' || !candidate.key.trim())) throw new Error('Enter an API key.');
    if (candidate.env !== undefined && (!candidate.env || typeof candidate.env !== 'object' || Array.isArray(candidate.env) ||
        Object.values(candidate.env).some((item) => typeof item !== 'string'))) throw new Error('Invalid provider configuration.');
    return { type: 'api_key', ...(candidate.key !== undefined ? { key: (candidate.key as string).trim() } : {}),
      ...(candidate.env ? { env: { ...candidate.env as Record<string, string> } } : {}) };
  }
  if (candidate.type !== 'oauth' || typeof candidate.access !== 'string' || !candidate.access.trim() ||
      typeof candidate.refresh !== 'string' || !candidate.refresh.trim() || typeof candidate.expires !== 'number' ||
      !Number.isFinite(candidate.expires) || candidate.expires <= 0) throw new Error('Invalid OAuth credential.');
  // Pi permits provider-specific fields (for example clientId and scopes). Keep
  // their JSON data intact without sharing nested references with SDK callers.
  return copyJson(candidate) as Credential;
}

class InvalidSavedCredentialError extends Error {
  constructor() { super('Your saved provider credentials could not be restored. Reconnect or remove them in Providers.'); }
}

/** Provider-keyed Pi credentials. Secrets stay outside conversation documents and React state. */
export class ProviderCredentialStore implements CredentialStore {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ProviderCredentialSnapshot;

  constructor(private readonly codex: ObservableCredentialStore, private readonly backend: CredentialBackend,
    private readonly policies: Readonly<Record<string, ProviderCredentialPolicy>> = {}) {
    this.snapshot = { ...codex.getSnapshot(), providers: {} };
    codex.subscribe(() => this.publish());
  }

  private record(id: string): ProviderRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { loaded: false, access: EMPTY_ACCESS };
      this.records.set(id, record);
    }
    return record;
  }
  registerProviders(providerIds: readonly string[]) {
    for (const id of providerIds) if (id !== CODEX_PROVIDER_ID) this.record(id);
    this.publish();
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;
  readonly getProviderSnapshot = (id: string): ProviderAccess => {
    if (id === CODEX_PROVIDER_ID) {
      const { ready, signedIn, error } = this.codex.getSnapshot();
      return { ready, connected: signedIn && !error, ...(signedIn ? { type: 'oauth' as const } : {}), ...(error ? { error } : {}) };
    }
    return this.records.get(id)?.access ?? EMPTY_ACCESS;
  };
  private publish() {
    const codex = this.codex.getSnapshot();
    const providers = Object.fromEntries([...this.records].map(([id, record]) => [id, record.access]));
    if (this.snapshot.ready === codex.ready && this.snapshot.signedIn === codex.signedIn && this.snapshot.error === codex.error &&
        Object.keys(this.snapshot.providers).length === this.records.size &&
        [...this.records].every(([id, record]) => this.snapshot.providers[id] === record.access)) return;
    this.snapshot = { ...codex, providers };
    for (const listener of this.listeners) listener();
  }
  private setAccess(id: string, error?: string) {
    const record = this.record(id);
    const next: ProviderAccess = { ready: true, connected: !!record.credential && !error,
      ...(record.credential ? { type: record.credential.type } : {}), ...(error ? { error } : {}) };
    if (record.access.ready !== next.ready || record.access.connected !== next.connected ||
        record.access.type !== next.type || record.access.error !== next.error) record.access = next;
    this.publish();
  }
  private storageError(id: string, operation: string): Error {
    const error = new Error(`Could not ${operation} your saved provider credentials. Unlock this device and try again.`);
    this.setAccess(id, error.message);
    return error;
  }
  private enqueue<T>(id: string, action: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const operation = (this.queues.get(id) ?? Promise.resolve()).then(() => {
      options?.signal?.throwIfAborted();
      return action();
    });
    // Abandoning a caller's wait must not release a lock held by native I/O or refresh.
    this.queues.set(id, operation.catch(() => {}));
    if (!options?.signal) return operation;
    const signal = options.signal;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  private async load(id: string, force = false) {
    const current = this.record(id);
    // The previous refresh token may already be spent. Retry persistence before
    // allowing any reader or modifier to see the old durable credential.
    if (current.pendingCredential) await this.save(id, current.pendingCredential);
    if (current.loaded && !current.access.error && !force) return;
    let raw: string | null;
    try { raw = await this.backend.getItemAsync(providerCredentialKey(id)); }
    catch { throw this.storageError(id, 'restore'); }
    let credential: Credential | undefined;
    if (raw !== null) {
      try {
        const record = JSON.parse(raw);
        if (record.version !== 1) throw new Error('Unsupported credential version.');
        credential = copyCredential(record.credential);
        this.policies[id]?.validate?.(credential);
      } catch {
        current.credential = undefined;
        current.loaded = true;
        const error = new InvalidSavedCredentialError();
        this.setAccess(id, error.message);
        throw error;
      }
    }
    current.credential = credential;
    current.loaded = true;
    this.setAccess(id);
  }
  private async save(id: string, credential: Credential) {
    this.policies[id]?.validate?.(credential);
    const record = this.record(id);
    try { await this.backend.setItemAsync(providerCredentialKey(id), JSON.stringify({ version: 1, credential })); }
    catch {
      if (credential.type === 'oauth') record.pendingCredential = credential;
      throw this.storageError(id, 'save');
    }
    record.credential = credential;
    record.pendingCredential = undefined;
    record.loaded = true;
    this.setAccess(id);
  }
  private async remove(id: string) {
    try { await this.backend.deleteItemAsync(providerCredentialKey(id)); }
    catch { throw this.storageError(id, 'remove'); }
    const record = this.record(id);
    record.credential = undefined;
    record.pendingCredential = undefined;
    record.loaded = true;
    this.setAccess(id);
  }
  async restore() {
    const results = await Promise.allSettled([this.codex.restore(), ...[...this.records.keys()].map((id) => this.enqueue(id, () => this.load(id, true)))]);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  restoreProvider(id: string): Promise<void> {
    return id === CODEX_PROVIDER_ID ? this.codex.restore() : this.enqueue(id, () => this.load(id, true));
  }
  /** Explicit user replacement can recover a malformed or newer-format record. */
  replaceApiKey(id: string, key: string): Promise<void> {
    if (id === CODEX_PROVIDER_ID) return Promise.reject(new Error('Use ChatGPT sign-in for this provider.'));
    return this.enqueue(id, async () => {
      const credential = copyCredential({ type: 'api_key', key });
      await this.save(id, credential);
    });
  }
  read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (id === CODEX_PROVIDER_ID) return this.codex.read(id, options);
    return this.enqueue(id, async () => {
      await this.load(id);
      options?.signal?.throwIfAborted();
      const credential = this.record(id).credential;
      return credential && copyCredential(credential);
    }, options);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const result = [...await this.codex.list(options)];
    for (const id of this.records.keys()) {
      const credential = await this.read(id, options);
      if (credential) result.push({ providerId: id, type: credential.type });
    }
    return result;
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (id === CODEX_PROVIDER_ID) return this.codex.modify(id, fn, options);
    return this.enqueue(id, async () => {
      try { await this.load(id); }
      catch (error) {
        // A fresh SDK login can explicitly replace invalid persisted data. Reads
        // preserve that data and report the problem until replacement or logout.
        if (!(error instanceof InvalidSavedCredentialError)) throw error;
      }
      options?.signal?.throwIfAborted();
      const current = this.record(id).credential;
      let next: Credential | undefined;
      try { next = await fn(current && copyCredential(current)); }
      catch (error) {
        if (this.policies[id]?.isPermanentAuthError?.(error)) {
          await this.remove(id);
          this.setAccess(id, 'Your provider session expired. Sign in again.');
        }
        throw error;
      }
      // A completed refresh can consume its predecessor even if the caller has
      // cancelled. Commit its result under this lock; a queued logout still wins.
      if (!this.policies[id]?.isCompletedRefresh?.(next)) options?.signal?.throwIfAborted();
      if (next === undefined) return current && copyCredential(current);
      const credential = copyCredential(next);
      await this.save(id, credential);
      return copyCredential(credential);
    }, options);
  }
  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    if (id === CODEX_PROVIDER_ID) return this.codex.delete(id, options);
    // Do not load here: logout must be able to discard a pending failed save.
    return this.enqueue(id, () => this.remove(id), options);
  }
}
