import type { WindowCommand } from '../rpc';

/** The commands the main process sends this window, for the screens that act on them. */
export interface Commands {
  dispatch(name: WindowCommand): void;
  subscribe(listener: (name: WindowCommand) => void): () => void;
}

export function createCommands(): Commands {
  const listeners = new Set<(name: WindowCommand) => void>();
  return {
    dispatch: (name) => {
      for (const listener of listeners) listener(name);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
