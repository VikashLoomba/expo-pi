import Storage from 'expo-sqlite/kv-store';

const KEY = 'pi.keep-alive.enabled';

export type KeepAliveSettings = ReturnType<typeof createKeepAliveSettings>;

/**
 * The opt-in for background keep-alive: off by default, and the Account screen explains the location use where it
 * is switched on. Stored with the app's other settings (expo-sqlite kv-store), subscribable like the other stores.
 */
export function createKeepAliveSettings() {
  let enabled = Storage.getItemSync(KEY) === 'true';
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => enabled,
    setEnabled(value: boolean) {
      if (enabled === value) return;
      enabled = value;
      if (value) Storage.setItemSync(KEY, 'true');
      else Storage.removeItemSync(KEY);
      for (const listener of [...listeners]) listener();
    },
  };
}
