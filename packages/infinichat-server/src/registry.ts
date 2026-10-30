import { defineRegistry, type RegistryView } from '@earendil-works/chord';
import {
  createRegistry, type Extension, type RegistryReader, type RegistrySnapshot,
} from '@earendil-works/pi-durable';

/**
 * The Durable extensions a server's plugins contribute for its Harness, by extension name: InfiniChat's own and any
 * plugin the user installs (chord `docs/guide.md` "Durable"). A plugin registers with `self.register(Extensions, …)`
 * from an object of lifetime `"host"`; a token of this name in its own module is the same registry.
 */
export const Extensions = defineRegistry<Extension>('infinichat.extensions');

/**
 * Durable's `RegistryReader` over the tables of `Extensions`, which Chord leaves to the application (chord
 * `docs/spec.md` §8): one complete snapshot per code version, built when its table is installed, so a Durable phase
 * pins a whole one and a reload never shows a moment without an extension. pi-durable builds and validates a snapshot
 * as a registry installs, so each table gets a registry of its own. A table pi-durable refuses, such as two plugins'
 * tasks of one name, is reported and the last snapshot stays.
 */
export function durableRegistry(view: RegistryView<Extension>, report: (error: unknown) => void,
): RegistryReader & { close(): void } {
  const listeners = new Set<() => void>();
  let current: RegistrySnapshot = createRegistry().snapshot();
  const stop = view.subscribe((table) => {
    try {
      const registry = createRegistry();
      for (const extension of table.values()) registry.install(extension);
      current = registry.snapshot();
    } catch (error) {
      report(error);
      return;
    }
    for (const listener of [...listeners]) listener();
  });
  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: stop,
  };
}
