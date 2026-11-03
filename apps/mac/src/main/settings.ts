import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { compile, map, num, obj, opt, str } from '@earendil-works/pi-schema';
import { Utils } from 'electrobun/main';

export interface WindowFrame { x: number; y: number; width: number; height: number }
/** What the app remembers between launches, in `settings.json` under its user data; later pieces add their fields. */
export interface Settings {
  windowFrame?: WindowFrame;
  /** This app's ID as a client of the InfiniChat servers, made once. */
  clientId?: string;
  /** The identity file chosen for a machine, by endpoint; without one, it is reached with the user's SSH setup. */
  identities?: Record<string, string>;
  /** InfiniChat's avatar: the name of the image file under `userData/avatar`, this Mac's alone. */
  avatar?: string;
}

const FILE = 'settings.json';
const stored = compile(obj({
  windowFrame: opt(obj({ x: num(), y: num(), width: num(), height: num() }, { open: true })),
  clientId: opt(str()), identities: opt(map(str())), avatar: opt(str()),
}, { open: true }));

export function readSettings(): Settings {
  let text: string;
  try {
    text = readFileSync(join(Utils.paths.userData, FILE), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  // Only `writeSettings` writes it; another shape starts over, as no file does.
  return stored.check(parsed) ? parsed : {};
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
