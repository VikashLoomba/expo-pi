import type { SettingsTarget } from '../../contract';
import type { WindowCommand } from '../../rpc';

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

/**
 * Which pane the Settings window shows: what the main process asked for when it opened the window or with `show`
 * since, and what its sidebar chose. One store, read as the phone reads its route's params.
 */
export interface SettingsTargets {
  show(target: SettingsTarget): void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): SettingsTarget;
}

export function createSettingsTargets(initial: SettingsTarget = { pane: 'machines' }): SettingsTargets {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    show: (target) => {
      current = target;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => current,
  };
}
