import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bool, compile, obj, opt, str } from '@earendil-works/pi-schema';
import {
  ClientSchema, ConversationFilesSchema, type ConversationState,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';

/**
 * What `~/.infinichat/state.json` keeps across restarts: whether this machine holds the conversation, with the files
 * it adopted or the phone it handed them to, the phone's time zone, and the release that last opened the database
 * here. The agent reads local times (message dates, scheduled times); the phone sends its IANA zone on every connect,
 * so those times match the phone's clock wherever the machine is.
 */
export type ServerState = ConversationState & { timeZone?: string; opened?: string };

const serverState = compile(obj({
  active: bool(), adopted: opt(ConversationFilesSchema), heldBy: opt(ClientSchema),
  timeZone: opt(str()), opened: opt(str()),
}, { open: true }));

/** The kept state; nothing is kept before the phone's first connect. */
export function readState(home: string): ServerState {
  const file = join(home, 'state.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { active: false };
    throw error;
  }
  const state: unknown = JSON.parse(text);
  // Only this module writes it, so another shape is a damaged file, as unparsable JSON is.
  if (!serverState.check(state)) throw new Error(`${file} is not InfiniChat's state.`);
  return state;
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
