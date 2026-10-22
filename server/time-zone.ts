import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The agent reads local times (message dates, scheduled times). The phone sends its IANA zone on every connect, and
// `state.json` keeps it across restarts, so those times match the phone's clock wherever the machine is. Node applies
// a change of `process.env.TZ` at run time.

/** Sets the zone `state.json` keeps, before anything reads the time; none is kept before the phone's first connect. */
export function restoreTimeZone(home: string): void {
  let text: string;
  try {
    text = readFileSync(join(home, 'state.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const state: unknown = JSON.parse(text);
  if (typeof state === 'object' && state !== null && 'timeZone' in state && typeof state.timeZone === 'string') {
    process.env.TZ = state.timeZone;
  }
}

/**
 * Keeps `zone` and applies it. Synchronous, so two calls never interleave their writes; the file is written aside and
 * renamed into place, so a crash never leaves half of it.
 */
export function setTimeZone(home: string, zone: string): void {
  // A name that is not an IANA zone throws a RangeError here, before anything changes.
  Intl.DateTimeFormat('en-US', { timeZone: zone });
  const file = join(home, 'state.json');
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ timeZone: zone }));
  renameSync(temporary, file);
  process.env.TZ = zone;
}
