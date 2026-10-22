import Storage from 'expo-sqlite/kv-store';

const KEY = 'pi.infinichat.machine.v1';

/**
 * Where InfiniChat runs: this iPhone (`null`) or the machine in Remote machines with this ID. Stored with the app's
 * other settings (expo-sqlite kv-store), as the machines themselves are, and subscribable like the other stores.
 */
export function createInfiniChatMachineChoice() {
  let machineId = Storage.getItemSync(KEY);
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => machineId,
    choose(id: string | null) {
      if (machineId === id) return;
      machineId = id;
      if (id === null) Storage.removeItemSync(KEY);
      else Storage.setItemSync(KEY, id);
      for (const listener of [...listeners]) listener();
    },
  };
}
