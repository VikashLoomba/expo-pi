import Storage from 'expo-sqlite/kv-store';

const KEY = 'pi.infinichat.home.v1';

/**
 * Where InfiniChat's conversation lives: this iPhone, or a machine in Remote machines with the phase of a move
 * between them. It is the authority on who may open the conversation's database, since pi-durable has no
 * cross-process locking: the phone opens it only at `phone`, and the machine only between its `adopt` and its
 * `relinquish`. A move writes each phase before the step that needs it, so a relaunch carries it on from there.
 */
export type InfiniChatHome =
  | { version: 1; home: 'phone' }
  | { version: 1; home: 'machine'; machineId: string; phase: 'moving-there' | 'there' | 'moving-back' };

export const PHONE_HOME: InfiniChatHome = { version: 1, home: 'phone' };

function parse(text: string | null): InfiniChatHome {
  if (text === null) return PHONE_HOME;
  const value: unknown = JSON.parse(text);
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'home' in value) {
    if (value.home === 'phone') return PHONE_HOME;
    if (value.home === 'machine' && 'machineId' in value && typeof value.machineId === 'string'
      && 'phase' in value
      && (value.phase === 'moving-there' || value.phase === 'there' || value.phase === 'moving-back')) {
      return { version: 1, home: 'machine', machineId: value.machineId, phase: value.phase };
    }
  }
  // Opening either side on a guess could open the conversation twice.
  throw new Error('Where InfiniChat’s conversation lives could not be read.');
}

/**
 * The home record, stored with the app's other settings (expo-sqlite kv-store) and written synchronously, so it is
 * saved before the step that follows it.
 */
export function createInfiniChatHome() {
  let home = parse(Storage.getItemSync(KEY));
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => home,
    set(next: InfiniChatHome) {
      Storage.setItemSync(KEY, JSON.stringify(next));
      home = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
export type InfiniChatHomeStore = ReturnType<typeof createInfiniChatHome>;
