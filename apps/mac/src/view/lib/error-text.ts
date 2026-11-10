/**
 * An error as a notice shows it: its message, or `fallback` for anything without one. A failed call rejects with a
 * Chord error or, for what the main process's own code threw, a plugin error; either crosses the link as its message
 * (chord `docs/design.md` §5, "Errors").
 */
export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
