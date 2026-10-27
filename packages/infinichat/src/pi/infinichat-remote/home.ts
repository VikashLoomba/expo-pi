const KEY = 'pi.infinichat.home.v1';

/**
 * Where InfiniChat's conversation lives: this device, or a machine in its list with the phase of a move between them.
 * It is the authority on who may open the conversation's database, since pi-durable has no cross-process locking:
 * this device opens it only at `phone`, and the machine only between its `adopt` and its `relinquish`. A move writes
 * each phase before the step that needs it, so a relaunch carries it on from there. `copyOn` is the machine this device
 * last moved it back from, whose copy it keeps fresh. `phone` is stored data, so it keeps its spelling; read it as
 * "this device".
 */
/** `from` names the machine a move straight to `machineId` leaves, while it is `moving-there`. */
export type InfiniChatHome =
  | { version: 1; home: 'phone'; copyOn?: string }
  | { version: 1; home: 'machine'; machineId: string; phase: 'moving-there' | 'there' | 'moving-back'; from?: string };

export const PHONE_HOME: InfiniChatHome = { version: 1, home: 'phone' };

/** Where an app keeps the home record: read and written synchronously, so a write is saved before the next step. */
export interface InfiniChatHomeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function parse(text: string | null): InfiniChatHome {
  if (text === null) return PHONE_HOME;
  const value: unknown = JSON.parse(text);
  if (typeof value === 'object' && value !== null && 'version' in value && value.version === 1 && 'home' in value) {
    if (value.home === 'phone') {
      return 'copyOn' in value && typeof value.copyOn === 'string'
        ? { version: 1, home: 'phone', copyOn: value.copyOn } : PHONE_HOME;
    }
    if (value.home === 'machine' && 'machineId' in value && typeof value.machineId === 'string'
      && 'phase' in value
      && (value.phase === 'moving-there' || value.phase === 'there' || value.phase === 'moving-back')) {
      const from = 'from' in value && typeof value.from === 'string' && value.phase === 'moving-there'
        ? { from: value.from } : {};
      return { version: 1, home: 'machine', machineId: value.machineId, phase: value.phase, ...from };
    }
  }
  // Opening either side on a guess could open the conversation twice.
  throw new Error('Where InfiniChat’s conversation lives could not be read.');
}

/** The home record, in the app's synchronous storage, so it is saved before the step that follows it. */
export function createInfiniChatHome(storage: InfiniChatHomeStorage) {
  let home = parse(storage.getItem(KEY));
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => home,
    set(next: InfiniChatHome) {
      storage.setItem(KEY, JSON.stringify(next));
      home = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
export type InfiniChatHomeStore = ReturnType<typeof createInfiniChatHome>;
