import type { JsonValue } from '@earendil-works/chord/json';
import { num, obj, str, type Static } from '@earendil-works/pi-schema';

/** Default lifetime of a secret held in RAM before it expires automatically. */
export const DEFAULT_SECRET_TTL_MS = 30 * 60 * 1000;
/** Secrets shorter than this are not globally scrubbed to avoid corrupting unrelated tool output. */
const MIN_REDACT_LENGTH = 4;
const REDACTED = '[REDACTED]';
const HANDLE_PREFIX = '{{secret:';
const HANDLE_SUFFIX = '}}';
const HANDLE_EXACT = /^\{\{secret:(s_[0-9a-f]+)\}\}$/;
const HANDLE_GLOBAL = /\{\{secret:(s_[0-9a-f]+)\}\}/g;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Metadata of a secret currently held in RAM, shown to clients so the user can inspect or clear it; never its value. */
export const ActiveSecretInfoSchema = obj({
  id: str(),
  label: str(),
  purpose: str(),
  agent: str(),
  expiresAt: num(),
}, { open: true });
export type ActiveSecretInfo = Static<typeof ActiveSecretInfoSchema>;

interface SecretRecord extends ActiveSecretInfo {
  readonly handle: string;
  readonly value: string;
}

/** Input when storing a newly provided secret in RAM. */
export interface MintSecretInput {
  readonly value: string;
  readonly label: string;
  readonly purpose: string;
  readonly agent: string;
  readonly ttlMs?: number;
}

/** Streaming text redactor that buffers trailing bytes so secrets split across chunks are still scrubbed. */
export interface StreamRedactor {
  push(chunk: string): void;
  flush(): void;
}

function randomSecretId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `s_${hex}`;
}

function expiredError(): Error {
  return new Error('Secret handle expired or was cleared. Call ask_user to request the credential again.');
}

/**
 * Ephemeral in-memory store for user-provided credentials. Values live only in this process's RAM and never enter
 * SQLite, pi-durable signals, memory summaries, or sync folders. Agents hold only opaque handles (`{{secret:s_...}}`)
 * resolved at tool execution boundaries (`bash`, `write`, `edit`, and MCP tools) and scrubbed from outputs.
 */
export class SecretVault {
  private readonly records = new Map<string, SecretRecord>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly ActiveSecretInfo[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getSnapshot = (): readonly ActiveSecretInfo[] => {
    this.purgeExpired();
    return this.snapshot;
  };

  /** Stores `value` in RAM and returns its opaque handle. */
  mint(input: MintSecretInput): { readonly id: string; readonly handle: string } {
    this.purgeExpired();
    const id = randomSecretId();
    const handle = `${HANDLE_PREFIX}${id}${HANDLE_SUFFIX}`;
    const expiresAt = Date.now() + (input.ttlMs ?? DEFAULT_SECRET_TTL_MS);
    this.records.set(id, {
      id,
      handle,
      value: input.value,
      label: input.label,
      purpose: input.purpose,
      agent: input.agent,
      expiresAt,
    });
    this.publish();
    this.scheduleExpiry();
    return { id, handle };
  }

  /** Whether any secret is currently live in RAM. */
  hasActive(): boolean {
    this.purgeExpired();
    return this.records.size > 0;
  }

  /** Whether `text` contains at least one secret handle token. */
  containsHandle(text: string): boolean {
    HANDLE_GLOBAL.lastIndex = 0;
    return HANDLE_GLOBAL.test(text);
  }

  /** Resolves one exact handle token to its raw secret value, or throws if unknown or expired. */
  resolveHandle(handle: string): string {
    this.purgeExpired();
    const match = HANDLE_EXACT.exec(handle.trim());
    if (!match) throw new Error(`Invalid secret handle ${JSON.stringify(handle)}. Expected a handle from ask_user.`);
    const record = this.records.get(match[1]);
    if (record === undefined) throw expiredError();
    return record.value;
  }

  /** Replaces every secret handle in `text` with its raw value, throwing if any handle is unknown or expired. */
  resolveString(text: string): string {
    if (!this.containsHandle(text)) return text;
    this.purgeExpired();
    return text.replace(HANDLE_GLOBAL, (_match, id: string) => {
      const record = this.records.get(id);
      if (record === undefined) throw expiredError();
      return record.value;
    });
  }

  /** Resolves a `bash` env-var binding map (`{ VAR: "{{secret:...}}" }`) into raw environment values. */
  resolveEnvMap(bindings: Readonly<Record<string, string>>): Record<string, string> {
    const resolved: Record<string, string> = {};
    for (const [name, handle] of Object.entries(bindings)) {
      if (!ENV_NAME.test(name)) {
        throw new Error(`Invalid secret environment variable name ${JSON.stringify(name)}.`);
      }
      resolved[name] = this.resolveHandle(handle);
    }
    return resolved;
  }

  /** Recursively resolves secret handles inside string values of an MCP/tool arguments object. */
  resolveRecord(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) out[key] = this.resolveUnknown(value);
    return out;
  }

  /** Replaces all live secret values (of at least `MIN_REDACT_LENGTH` chars) in `text` with `[REDACTED]`. */
  redactString(text: string): string {
    const values = this.redactableValues();
    if (values.length === 0 || text.length < MIN_REDACT_LENGTH) return text;
    return redactWith(text, values);
  }

  /** Recursively redacts live secret values inside a JSON value (for `structuredOutput` and `details`). */
  redactJson(value: JsonValue): JsonValue {
    const values = this.redactableValues();
    if (values.length === 0) return value;
    return redactJsonWith(value, values);
  }

  /**
   * Buffers trailing characters across streaming chunks so a secret split across chunk boundaries is still redacted
   * before reaching `api.output()`.
   */
  createStreamRedactor(emit: (chunk: string) => void): StreamRedactor {
    let pending = '';
    return {
      push: (chunk: string) => {
        if (!chunk) return;
        const values = this.redactableValues();
        if (values.length === 0) {
          if (pending) {
            emit(pending);
            pending = '';
          }
          emit(chunk);
          return;
        }
        const combined = redactWith(pending + chunk, values);
        // Longest active secret minus one character is the widest possible partial prefix at the chunk tail.
        const keep = Math.max(0, values[0].length - 1);
        if (combined.length > keep) {
          emit(combined.slice(0, combined.length - keep));
          pending = combined.slice(combined.length - keep);
        } else {
          pending = combined;
        }
      },
      flush: () => {
        if (!pending) return;
        const tail = this.redactString(pending);
        pending = '';
        if (tail) emit(tail);
      },
    };
  }

  /** Clears one secret by ID, or all active secrets when `id` is omitted. */
  clear(id?: string): void {
    if (id === undefined) {
      if (this.records.size === 0) return;
      this.records.clear();
    } else if (!this.records.delete(id)) {
      return;
    }
    this.publish();
    this.scheduleExpiry();
  }

  /** Disposes timers and wipes all secrets from memory. */
  close(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.records.clear();
    this.snapshot = [];
    this.listeners.clear();
  }

  private resolveUnknown(value: unknown): unknown {
    if (typeof value === 'string') return this.resolveString(value);
    if (Array.isArray(value)) return value.map((item) => this.resolveUnknown(item));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) out[key] = this.resolveUnknown(entry);
      return out;
    }
    return value;
  }

  /** Active secret strings eligible for scrubbing, longest first so overlapping secrets redact cleanly. */
  private redactableValues(): string[] {
    this.purgeExpired();
    if (this.records.size === 0) return [];
    const unique = new Set<string>();
    for (const record of this.records.values()) {
      if (record.value.length >= MIN_REDACT_LENGTH) unique.add(record.value);
    }
    return [...unique].sort((a, b) => b.length - a.length);
  }

  private purgeExpired(): void {
    if (this.records.size === 0) return;
    const now = Date.now();
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        changed = true;
      }
    }
    if (changed) {
      this.publish();
      this.scheduleExpiry();
    }
  }

  private scheduleExpiry(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    let earliest: number | undefined;
    for (const record of this.records.values()) {
      if (earliest === undefined || record.expiresAt < earliest) earliest = record.expiresAt;
    }
    if (earliest === undefined) return;
    const delay = Math.max(100, earliest - Date.now() + 50);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.purgeExpired();
    }, delay);
    if (typeof this.timer === 'object' && 'unref' in this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  private publish(): void {
    this.snapshot = [...this.records.values()]
      .sort((a, b) => a.expiresAt - b.expiresAt)
      .map(({ id, label, purpose, agent, expiresAt }) => ({ id, label, purpose, agent, expiresAt }));
    for (const listener of [...this.listeners]) listener();
  }
}

function redactWith(text: string, values: readonly string[]): string {
  let out = text;
  for (const secret of values) {
    if (out.includes(secret)) out = out.replaceAll(secret, REDACTED);
  }
  return out;
}

function redactJsonWith(value: JsonValue, values: readonly string[]): JsonValue {
  if (typeof value === 'string') return redactWith(value, values);
  if (Array.isArray(value)) return value.map((item) => redactJsonWith(item, values));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactJsonWith(entry, values);
    return out;
  }
  return value;
}
