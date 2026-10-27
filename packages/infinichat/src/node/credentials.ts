import { readFile, rename, writeFile } from 'node:fs/promises';

import type { CredentialBackend } from '../pi/provider-credentials';

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
