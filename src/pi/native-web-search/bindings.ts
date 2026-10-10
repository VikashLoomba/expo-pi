import type { ConversationId, EntryDraft, Tx } from '@earendil-works/pi-durable';

/** How the decorator persists through pi-durable; every call rejects on failure. */
export interface NativeWebSearchWriter {
  commit(change: (tx: Tx) => void | Promise<void>, signal: AbortSignal): Promise<void>;
  submit(entry: EntryDraft, requestId: string, signal: AbortSignal): Promise<void>;
}

/** Correlation only: canonical data lives in pi-durable. The generation hook's `context.abortSignal` is the
 * stream options' `signal` (verified in scheduler/generation at the vendored revision), so the request's own
 * signal keys what its provider stream may write. */
export type NativeWebSearchBinding = {
  conversationId: ConversationId;
  /** The generation task, so the live row shows only while its own run is busy. */
  taskId: number;
  write: NativeWebSearchWriter;
  /** The Harness's `onReport`: failures that do not fail a call. */
  report(error: unknown): void;
};

const bindings = new WeakMap<AbortSignal, NativeWebSearchBinding>();

export function bindNativeWebSearch(signal: AbortSignal, binding: NativeWebSearchBinding): void {
  bindings.set(signal, binding);
}

export function nativeWebSearchBinding(signal: AbortSignal | undefined): NativeWebSearchBinding | undefined {
  return signal ? bindings.get(signal) : undefined;
}
