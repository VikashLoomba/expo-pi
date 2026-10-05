import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from '@earendil-works/pi-ai';

import { isCompletedCodexRefresh, isPermanentCodexAuthError } from './core';
import { CODEX_PROVIDER_ID } from './identity';

export interface CredentialBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}
export interface CredentialSnapshot { ready: boolean; signedIn: boolean; error?: string }

function copyCredential(value: unknown): OAuthCredential {
  if (!value || typeof value !== 'object') throw new Error('Invalid credential.');
  const item = value as Record<string, unknown>;
  if (item.type !== 'oauth' || typeof item.access !== 'string' || !item.access ||
      typeof item.refresh !== 'string' || !item.refresh || typeof item.expires !== 'number' ||
      !Number.isFinite(item.expires) || item.expires <= 0 || typeof item.accountId !== 'string' || !item.accountId) {
    throw new Error('Invalid credential.');
  }
  return { type: 'oauth', access: item.access, refresh: item.refresh, expires: item.expires, accountId: item.accountId };
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** One atomic credential record; Pi runs refresh inside this store's mutation lock. */
export class ObservableCredentialStore implements CredentialStore {
  private credential?: OAuthCredential;
  // A server may already have rotated its refresh token when a Keychain write
  // fails. Retain that result for a storage retry, never refresh the old token.
  private pendingCredential?: OAuthCredential;
  private loaded = false;
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: CredentialSnapshot = { ready: false, signedIn: false };
  private listeners = new Set<() => void>();
  private readonly backend: CredentialBackend;
  private readonly key: string;

  constructor(backend: CredentialBackend, namespace = 'pi.codex.oauth.v1') {
    this.backend = backend;
    this.key = namespace;
  }

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(error?: string) {
    const next = { ready: true, signedIn: !!this.credential, ...(error ? { error } : {}) };
    if (this.snapshot.ready === next.ready && this.snapshot.signedIn === next.signedIn && this.snapshot.error === next.error) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private storageError(operation: 'restore' | 'save' | 'remove') {
    const error = new Error(`Could not ${operation} your saved sign-in. Unlock this device and try again.`);
    this.publish(error.message);
    return error;
  }
  private enqueue<T>(action: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    const operation = this.queue.then(async () => { options?.signal?.throwIfAborted(); return action(); });
    // An aborted caller may stop waiting, but never release a lock while its
    // native operation or refresh callback is still running.
    this.queue = operation.catch(() => {});
    return abortable(operation, options?.signal);
  }
  private async load(force = false) {
    if (this.pendingCredential) await this.save(this.pendingCredential);
    if (this.loaded && !force) return;
    let raw: string | null;
    try { raw = await this.backend.getItemAsync(this.key); }
    catch { throw this.storageError('restore'); }
    let credential: OAuthCredential | undefined;
    if (raw !== null) {
      try {
        const record = JSON.parse(raw);
        if (record.version !== 1) throw new Error('Unsupported credential version.');
        credential = copyCredential(record.credential);
      } catch {
        // Corrupt records cannot authenticate. Remove them rather than repeatedly
        // attempting refresh with incomplete tokens; native I/O errors remain retryable.
        try { await this.backend.deleteItemAsync(this.key); }
        catch { throw this.storageError('remove'); }
        this.credential = undefined;
        this.loaded = true;
        this.publish('Your saved sign-in could not be restored. Please sign in again.');
        return;
      }
    }
    this.credential = credential;
    this.loaded = true;
    this.publish();
  }
  restore(): Promise<void> { return this.enqueue(() => this.load(true)); }
  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      if (providerId !== CODEX_PROVIDER_ID) return undefined;
      await this.load();
      options?.signal?.throwIfAborted();
      return this.credential ? { ...this.credential } : undefined;
    }, options);
  }
  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () => {
      await this.load();
      options?.signal?.throwIfAborted();
      return this.credential ? [{ providerId: CODEX_PROVIDER_ID, type: 'oauth' }] : [];
    }, options);
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      if (providerId !== CODEX_PROVIDER_ID) throw new Error('This credential store supports ChatGPT sign-in only.');
      await this.load();
      options?.signal?.throwIfAborted();
      let next: Credential | undefined;
      try { next = await fn(this.credential ? { ...this.credential } : undefined); }
      catch (error) {
        if (isPermanentCodexAuthError(error)) {
          // Already under the mutation lock: queuing delete() here would deadlock.
          await this.remove();
          this.publish('Your ChatGPT session expired. Sign in again.');
        }
        throw error;
      }
      // A completed refresh may have consumed its predecessor. Finish saving
      // under this lock even when the caller aborted; queued logout still wins.
      if (!isCompletedCodexRefresh(next)) options?.signal?.throwIfAborted();
      if (next !== undefined) {
        const valid = copyCredential(next);
        await this.save(valid);
      }
      return this.credential ? { ...this.credential } : undefined;
    }, options);
  }
  private async save(credential: OAuthCredential) {
    try { await this.backend.setItemAsync(this.key, JSON.stringify({ version: 1, credential })); }
    catch {
      this.pendingCredential = credential;
      throw this.storageError('save');
    }
    // Native writes cannot be cancelled after admission. Publish the actual
    // committed state even if the caller stopped waiting during the write.
    this.pendingCredential = undefined;
    this.credential = credential;
    this.loaded = true;
    this.publish();
  }
  private async remove() {
    try { await this.backend.deleteItemAsync(this.key); }
    catch { throw this.storageError('remove'); }
    this.credential = undefined;
    this.pendingCredential = undefined;
    this.loaded = true;
    this.publish();
  }
  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      if (providerId === CODEX_PROVIDER_ID) await this.remove();
    }, options);
  }
}
