import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import type { LoginOptions } from '@earendil-works/pi-ai';

import type { CredentialBackend } from '../src/pi/secure-storage';

const isStringRecord = (value: unknown): value is Record<string, string> => typeof value === 'object'
  && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');

/**
 * The machine's `CredentialBackend` for the app's `ProviderCredentialStore`, as the Keychain is the phone's: one JSON
 * object of the store's items in `file`, readable only by this account. Each write rewrites the file aside and renames
 * it into place, so a crash never leaves half of it, and writes run one at a time, so one item's write never drops
 * another's. The store itself orders the operations on each provider.
 */
export function fileCredentialBackend(file: string): CredentialBackend {
  const read = async (): Promise<Record<string, string>> => {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw error;
    }
    const items: unknown = JSON.parse(text);
    if (!isStringRecord(items)) throw new Error(`${file} does not hold credentials.`);
    return items;
  };
  let writes = Promise.resolve();
  const write = (change: (items: Record<string, string>) => void) => {
    const written = writes.then(async () => {
      const items = await read();
      change(items);
      const temporary = `${file}.${process.pid}`;
      await writeFile(temporary, JSON.stringify(items), { mode: 0o600 });
      await rename(temporary, file);
    });
    writes = written.catch(() => {});
    return written;
  };
  return {
    getItemAsync: async (key) => (await read())[key] ?? null,
    setItemAsync: (key, value) => write((items) => { items[key] = value; }),
    deleteItemAsync: (key) => write((items) => { delete items[key]; }),
  };
}

/** The phone's key for its OpenAI installation ID (`src/pi/openai-auth/installation.ts`), beside the credentials. */
const HOST_KEY = 'pi.openai.host.v1';

/**
 * pi-ai's ChatGPT sign-in names this installation to OpenAI and must get the same ID every time
 * (`LoginOptions.getDeviceId`); its own CLI makes a new one per login and says apps should keep one. This machine is
 * its own installation, so it keeps its own, made at its first sign-in. `agentName` is the name the phone's sign-in
 * gives OpenAI.
 */
export async function openAILoginOptions(backend: CredentialBackend): Promise<LoginOptions> {
  const saved = await backend.getItemAsync(HOST_KEY);
  const id = saved ?? randomUUID();
  if (saved === null) await backend.setItemAsync(HOST_KEY, id);
  return { getDeviceId: () => id, agentName: 'InfiniChat' };
}
