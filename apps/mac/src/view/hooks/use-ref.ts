import { isChordError, type Readable, type RefStatus } from '@earendil-works/chord';
import { useSyncExternalStore } from 'react';

/** Chord's code prefix, which a server's error carries again on the client (chord `src/errors.ts:36`). */
const CODE_PREFIX = /^[a-z_]+(\/[a-z_]+)?: /;

/** An error as a notice shows it: a Chord error's message without its code; `fallback` for anything else. */
export function errorText(error: unknown, fallback: string): string {
  if (isChordError(error)) return error.message.replace(CODE_PREFIX, '');
  return error instanceof Error && error.message ? error.message : fallback;
}

interface Watched {
  readonly status: RefStatus;
  onStatus(listener: (status: RefStatus, error: unknown) => void): () => void;
}

/** A reference's status, re-rendering on every change: `loading` while a link reconnects, `gone` to get it again. */
export function useStatus(ref: Watched): RefStatus {
  return useSyncExternalStore((onChange) => ref.onStatus(onChange), () => ref.status);
}

/**
 * A state member's current value, or undefined before its first hydration, when reading it throws `not_ready` (chord
 * `docs/guide.md`, "References"); the member calls its listener with that first value, so the screen reads again.
 */
export function useMember<T>(member: Readable<T>): T | undefined {
  return useSyncExternalStore((onChange) => member.subscribe(onChange), () => {
    try {
      return member.value;
    } catch (error) {
      if (isChordError(error, 'not_ready')) return undefined;
      throw error;
    }
  });
}
