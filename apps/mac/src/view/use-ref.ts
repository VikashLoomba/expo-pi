import { isChordError, type Readable, type RefStatus } from '@earendil-works/chord';
import { useSyncExternalStore } from 'react';

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
