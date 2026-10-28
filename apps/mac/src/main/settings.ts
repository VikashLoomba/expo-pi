import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Utils } from 'electrobun/main';

export interface WindowFrame { x: number; y: number; width: number; height: number }
/** What the app remembers between launches, in `settings.json` under its user data; later pieces add their fields. */
export interface Settings {
  windowFrame?: WindowFrame;
  /** This app's ID as a client of the InfiniChat servers, made once. */
  clientId?: string;
}

const FILE = 'settings.json';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isFrame = (value: unknown): value is WindowFrame => isRecord(value)
  && [value.x, value.y, value.width, value.height].every((field) => typeof field === 'number');

export function readSettings(): Settings {
  let text: string;
  try {
    text = readFileSync(join(Utils.paths.userData, FILE), 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return {};
  return {
    ...(isFrame(parsed.windowFrame) ? { windowFrame: parsed.windowFrame } : {}),
    ...(typeof parsed.clientId === 'string' ? { clientId: parsed.clientId } : {}),
  };
}

/** Written aside and renamed into place; the user data directory is not created for the app (Electrobun "Paths"). */
export function writeSettings(settings: Settings): void {
  const directory = Utils.paths.userData;
  mkdirSync(directory, { recursive: true });
  const path = join(directory, FILE);
  const temporary = `${path}.${process.pid}`;
  writeFileSync(temporary, JSON.stringify(settings));
  renameSync(temporary, path);
}
