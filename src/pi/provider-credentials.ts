import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

import type { CredentialBackend } from './secure-storage';

export interface ProviderAccess {
  ready: boolean;
  connected: boolean;
  type?: Credential['type'];
  error?: string;
  /** The error came from device storage, so retrying can succeed once the device is unlocked. */
  retryable?: boolean;
}
/** Protocol adapters validate stored grants and identify terminal authentication failures. */
export interface ProviderCredentialPolicy {
  validate?(credential: Credential): void;
  /** The provider refused a refresh, so only a new sign-in restores access. */
  isPermanentAuthError?(error: unknown): boolean;
}
/**
 * Why a provider whose refresh was refused cannot send. A provider's access reports it only while it carries the
 * expired mark, so a send that meets an OAuth failure can tell a refused refresh from any other.
 */
export const SESSION_EXPIRED = 'Session expired — sign in again';
interface ProviderRecord {
  credential?: Credential;
  pendingCredential?: Credential;
  loaded: boolean;
  /** A refresh was refused. pi-ai keeps the credential; a new one replaces it and clears this. */
  expired: boolean;
  access: ProviderAccess;
}
interface ProviderCredentialSnapshot { providers: Readonly<Record<string, ProviderAccess>> }
const EMPTY_ACCESS: ProviderAccess = { ready: false, connected: false };

export function providerCredentialKey(providerId: string) {
  // Keep the existing key namespace so saved API keys remain available after upgrade.
  const codePoints = Array.from(providerId, (character) => (character.codePointAt(0) ?? 0).toString(16));
  return `pi.provider.api-key.v1.${codePoints.join('-')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

/** Decodes a SecureStore entry, the one place credential data arrives untyped. */
function decodeSavedCredential(raw: string): Credential {
  const saved: unknown = JSON.parse(raw);
  const value = isRecord(saved) && saved.version === 1 ? saved.credential : undefined;
  if (!isRecord(value)) throw new Error('Invalid saved credential.');
  const { type, key, env, access, refresh, expires } = value;
  if (type === 'api_key' && (key === undefined || typeof key === 'string')
      && (env === undefined || isStringRecord(env))) {
    return { type, ...(key === undefined ? {} : { key }), ...(env === undefined ? {} : { env }) };
  }
  // Pi permits provider-specific OAuth fields, for example clientId and scopes.
  if (type === 'oauth' && typeof access === 'string' && typeof refresh === 'string' && typeof expires === 'number') {
    return { ...value, type, access, refresh, expires };
  }
  throw new Error('Invalid saved credential.');
}

class InvalidSavedCredentialError extends Error {
  constructor() { super('Your saved provider credentials could not be restored. Reconnect or remove them in Providers.'); }
}

/** Provider-keyed Pi credentials. Secrets stay outside conversation documents and React state. */
export class ProviderCredentialStore implements CredentialStore {
  private readonly records = new Map<string, ProviderRecord>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ProviderCredentialSnapshot = { providers: {} };

  constructor(private readonly backend: CredentialBackend,
    private readonly policies: Readonly<Record<string, ProviderCredentialPolicy>> = {}) {}

  private record(id: string): ProviderRecord {
    let record = this.records.get(id);
    if (!record) {
      record = { loaded: false, expired: false, access: EMPTY_ACCESS };
      this.records.set(id, record);
    }
    return record;
  }
  registerProviders(providerIds: readonly string[]) {
    for (const id of providerIds) this.record(id);
    this.publish();
  }
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.snapshot;
  readonly getProviderSnapshot = (id: string): ProviderAccess => this.records.get(id)?.access ?? EMPTY_ACCESS;
  private publish() {
    if (Object.keys(this.snapshot.providers).length === this.records.size &&
        [...this.records].every(([id, record]) => this.snapshot.providers[id] === record.access)) return;
    this.snapshot = { providers: Object.fromEntries([...this.records].map(([id, record]) => [id, record.access])) };
    for (const listener of this.listeners) listener();
  }
  private setAccess(id: string, explicitError?: string, retryable = false) {
    const record = this.record(id);
    // The expired mark outlives later reads, which reload the same credential.
    const error = explicitError ?? (record.expired ? SESSION_EXPIRED : undefined);
    const next: ProviderAccess = { ready: true, connected: !!record.credential && !error,
      ...(record.credential ? { type: record.credential.type } : {}),
      ...(error ? { error, ...(retryable ? { retryable } : {}) } : {}) };
    if (record.access.ready !== next.ready || record.access.connected !== next.connected ||
        record.access.type !== next.type || record.access.error !== next.error ||
        record.access.retryable !== next.retryable) record.access = next;
    this.publish();
  }
  private storageError(id: string, operation: string): Error {
    const error = new Error(`Could not ${operation} your saved provider credentials. Unlock this device and try again.`);
    this.setAccess(id, error.message, true);
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
        credential = decodeSavedCredential(raw);
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
    record.expired = false;
    this.setAccess(id);
  }
  private async remove(id: string) {
    try { await this.backend.deleteItemAsync(providerCredentialKey(id)); }
    catch { throw this.storageError(id, 'remove'); }
    const record = this.record(id);
    record.credential = undefined;
    record.pendingCredential = undefined;
    record.loaded = true;
    record.expired = false;
    this.setAccess(id);
  }
  async restore() {
    const results = await Promise.allSettled([...this.records.keys()].map((id) => this.restoreProvider(id)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
  restoreProvider(id: string): Promise<void> {
    return this.enqueue(id, () => this.load(id, true));
  }
  read(id: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(id, async () => {
      await this.load(id);
      options?.signal?.throwIfAborted();
      return this.record(id).credential;
    }, options);
  }
  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    const result: CredentialInfo[] = [];
    for (const id of this.records.keys()) {
      const credential = await this.read(id, options);
      if (credential) result.push({ providerId: id, type: credential.type });
    }
    return result;
  }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(id, async () => {
      try { await this.load(id); }
      catch (error) {
        // A fresh login or saved API key can replace invalid persisted data. Reads
        // preserve that data and report the problem until replacement or logout.
        if (!(error instanceof InvalidSavedCredentialError)) throw error;
      }
      options?.signal?.throwIfAborted();
      const current = this.record(id).credential;
      let next: Credential | undefined;
      try { next = await fn(current); }
      catch (error) {
        // As pi-ai documents, a failed refresh keeps the stored credential for re-login.
        if (this.policies[id]?.isPermanentAuthError?.(error)) {
          this.record(id).expired = true;
          this.setAccess(id);
        }
        throw error;
      }
      // Pi passes refresh a lock-wait signal that it detaches before calling this
      // modifier, so only abandoned logins and direct writes are discarded here.
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      await this.save(id, next);
      return next;
    }, options);
  }
  delete(id: string, options?: AuthOperationOptions): Promise<void> {
    // Do not load here: logout must be able to discard a pending failed save.
    return this.enqueue(id, () => this.remove(id), options);
  }
}
