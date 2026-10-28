import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  createInfiniChatHome, type InfiniChatHome, type InfiniChatHomeStore,
} from '@pi-agent/infinichat/pi/infinichat-remote/home';
import { Utils } from 'electrobun/main';

const FILE = 'infinichat-home.json';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Where InfiniChat lives, in a file of its own under the app's user data, read and written synchronously as the
 * record asks, as the phone keeps it in expo-sqlite's kv-store. The file holds the record's value alone.
 */
export function macHome(self: string): InfiniChatHomeStore {
  const path = join(Utils.paths.userData, FILE);
  // The app itself never holds the conversation: from the first launch it is on this Mac's own server, named by
  // this Mac's endpoint as every machine is.
  const first: InfiniChatHome = { version: 1, home: 'machine', machineId: self, phase: 'there' };
  return createInfiniChatHome({
    getItem: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error) {
        if (isRecord(error) && error.code === 'ENOENT') return JSON.stringify(first);
        throw error;
      }
    },
    setItem: (_key, value) => {
      mkdirSync(Utils.paths.userData, { recursive: true });
      const temporary = `${path}.${process.pid}`;
      writeFileSync(temporary, value);
      renameSync(temporary, path);
    },
  });
}
