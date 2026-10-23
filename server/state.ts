import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConversationFiles, ConversationState } from '../src/pi/infinichat-remote/contract';

/**
 * What `~/.infinichat/state.json` keeps across restarts: whether this machine holds the conversation, with the files
 * it adopted, and the phone's time zone. The agent reads local times (message dates, scheduled times); the phone sends
 * its IANA zone on every connect, so those times match the phone's clock wherever the machine is.
 */
export type ServerState = ConversationState & { timeZone?: string };

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const fileOf = (value: unknown) => isRecord(value) && typeof value.sha256 === 'string'
  && typeof value.size === 'number' ? { sha256: value.sha256, size: value.size } : undefined;

function filesOf(value: unknown): ConversationFiles | undefined {
  const db = isRecord(value) ? fileOf(value.db) : undefined;
  return db && { db };
}

/** The kept state; nothing is kept before the phone's first connect. */
export function readState(home: string): ServerState {
  let text: string;
  try {
    text = readFileSync(join(home, 'state.json'), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { active: false };
    throw error;
  }
  const state: unknown = JSON.parse(text);
  if (!isRecord(state)) return { active: false };
  const adopted = filesOf(state.adopted);
  return {
    active: state.active === true,
    ...(adopted === undefined ? {} : { adopted }),
    ...(typeof state.timeZone === 'string' ? { timeZone: state.timeZone } : {}),
  };
}

/**
 * Reads the state, changes it and writes it back. Synchronous, so two changes never interleave; written aside and
 * renamed into place, so a crash never leaves half of it. The phone's move script reads `"active":true` from it.
 */
export function updateState(home: string, change: (state: ServerState) => ServerState): ServerState {
  const state = change(readState(home));
  const file = join(home, 'state.json');
  const temporary = `${file}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, file);
  return state;
}

/** Sets the kept zone before anything reads the time. Node applies a change of `process.env.TZ` at run time. */
export function restoreTimeZone(home: string): void {
  const { timeZone } = readState(home);
  if (timeZone !== undefined) process.env.TZ = timeZone;
}

/** Keeps `zone` and applies it. */
export function setTimeZone(home: string, zone: string): void {
  // A name that is not an IANA zone throws a RangeError here, before anything changes.
  Intl.DateTimeFormat('en-US', { timeZone: zone });
  updateState(home, (state) => ({ ...state, timeZone: zone }));
  process.env.TZ = zone;
}
