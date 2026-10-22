import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

import type { LoginOptions } from '@earendil-works/pi-ai';

import type { CredentialBackend } from '../src/pi/secure-storage';

const isStringRecord = (value: unknown): value is Record<string, string> => typeof value === 'object'
  && value !== null && !Array.isArray(value) && Object.values(value).every((item) => typeof item === 'string');

/** Its items, or none when it is not one JSON object of strings, as pi-ai's CLI reads an unparsable `auth.json`. */
function parsed(text: string): Record<string, string> {
  try {
    const items: unknown = JSON.parse(text);
    return isStringRecord(items) ? items : {};
  } catch {
    return {};
  }
}

/**
 * The machine's `CredentialBackend` for the app's `ProviderCredentialStore`, as the Keychain is the phone's: one JSON
 * object of the store's items in `file`, readable only by this account. Each write rewrites the file aside and renames
 * it into place, so a crash never leaves half of it, and writes run one at a time, so one item's write never drops
 * another's. The store itself orders the operations on each provider. A file that does not parse reads as empty, so
 * the next sign-in or key from the phone replaces it (pi-ai `src/cli.ts:19-26`); a file that cannot be read throws.
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
    return parsed(text);
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * pi-ai's ChatGPT sign-in names this installation to OpenAI and must get the same ID every time
 * (`LoginOptions.getDeviceId`); its own CLI makes a new one per login and says apps should keep one. This machine is
 * its own installation, so it keeps its own, made at its first sign-in, read once per process as the phone's
 * `getOpenAILoginOptions` does. `agentName` is the name the phone's sign-in gives OpenAI.
 */
export function openAILoginOptions(backend: CredentialBackend): () => Promise<LoginOptions> {
  let pending: Promise<LoginOptions> | undefined;
  return () => {
    pending ??= (async () => {
      const saved = await backend.getItemAsync(HOST_KEY);
      if (saved !== null && !UUID.test(saved)) {
        throw new Error('The saved OpenAI installation ID could not be restored.');
      }
      const id = saved ?? randomUUID();
      if (saved === null) await backend.setItemAsync(HOST_KEY, id);
      return { getDeviceId: () => id, agentName: 'InfiniChat' };
    })().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
