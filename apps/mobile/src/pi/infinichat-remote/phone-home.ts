import { machineEndpoint } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { createInfiniChatHome } from '@pi-agent/infinichat/pi/infinichat-remote/home';
import Storage from 'expo-sqlite/kv-store';

const HOSTS_KEY = 'pi.remote-hosts.v1';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * A home record from before the machines document (2026-10-28) names its machine by the ID the phone's list gave it;
 * since then a machine's ID is its endpoint. The list maps the one to the other: its version 1 by the records
 * themselves, its version 2 by the `legacy` map the conversion keeps. A record already by endpoint is returned as
 * it is.
 */
function byEndpoint(text: string | null): string | null {
  if (text === null) return null;
  const home: unknown = JSON.parse(text);
  if (!isRecord(home) || home.home !== 'machine') return text;
  const index: unknown = JSON.parse(Storage.getItemSync(HOSTS_KEY) ?? 'null');
  if (!isRecord(index)) return text;
  const hosts: unknown[] = Array.isArray(index.hosts) ? index.hosts : [];
  const legacy = isRecord(index.legacy) ? index.legacy : {};
  const endpointOf = (id: unknown) => {
    if (typeof id !== 'string') return undefined;
    const known = legacy[id];
    if (typeof known === 'string') return known;
    if (index.version !== 1) return undefined;
    const host = hosts.find((entry) => isRecord(entry) && entry.id === id);
    return isRecord(host) && typeof host.hostname === 'string' && typeof host.port === 'number'
      && typeof host.username === 'string' ? machineEndpoint({ hostname: host.hostname, port: host.port,
        username: host.username }) : undefined;
  };
  const machineId = endpointOf(home.machineId);
  if (machineId === undefined) return text;
  const from = endpointOf(home.from);
  return JSON.stringify({ ...home, machineId, ...(from === undefined ? {} : { from }) });
}

/**
 * Where InfiniChat lives, stored with the app's other settings (expo-sqlite kv-store) through its synchronous calls. A
 * record the migration rewrites is stored at once, since the version 1 list it reads goes at the list's next load.
 */
export const createPhoneHome = () => createInfiniChatHome({
  getItem: (key) => {
    const text = Storage.getItemSync(key);
    const migrated = byEndpoint(text);
    if (migrated !== null && migrated !== text) Storage.setItemSync(key, migrated);
    return migrated;
  },
  setItem: (key, value) => Storage.setItemSync(key, value),
});
