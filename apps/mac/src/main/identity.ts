import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

import type { InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';

import { writeSettings, type Settings } from './settings';

/** The Mac's name as System Settings shows it; the host name without `.local` when it can't be read. */
async function computerName(): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)('scutil', ['--get', 'ComputerName']);
    if (stdout.trim()) return stdout.trim();
  } catch {
    // The host name below.
  }
  return hostname().replace(/\.local$/, '');
}

/**
 * This app as a client of the machines' InfiniChat servers, as `phone-client.ts` is the phone: its ID, made once and
 * kept in `settings.json`, which names its secret's file on each machine, and the name a machine records when the
 * conversation is handed to it. `settings` is the app's one copy, so a later write keeps the ID.
 */
export async function macClient(settings: Settings): Promise<InfiniChatClient> {
  if (settings.clientId === undefined) {
    settings.clientId = randomUUID();
    writeSettings(settings);
  }
  return { id: settings.clientId, name: await computerName() };
}
