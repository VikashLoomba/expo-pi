import { defineRegistry, type RegistryTable, type RegistryView } from '@earendil-works/chord';
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
 * Extensions that change while the server runs rather than with its code, such as an MCP server's tools once it has
 * listed them: pi-durable's registry is the application's and may change while the Harness runs, new work using the
 * new state (durable README "Concepts"), while a Chord registration changes only when code is committed.
 */
export interface LiveExtensions {
  extensions(): readonly Extension[];
  subscribe(listener: () => void): () => void;
}

/**
 * Durable's `RegistryReader` over the tables of `Extensions`, which Chord leaves to the application (chord
 * `docs/spec.md` §8), followed by `live`'s: one complete snapshot per code version and per change of `live`, so a
 * Durable phase pins a whole one and a reload never shows a moment without an extension. pi-durable builds and
 * validates a snapshot as a registry installs, so each gets a registry of its own. One pi-durable refuses, such as two
 * plugins' tasks of one name, is reported and the last snapshot stays.
 */
export function durableRegistry(view: RegistryView<Extension>, live: LiveExtensions,
  report: (error: unknown) => void): RegistryReader & { close(): void } {
  const listeners = new Set<() => void>();
  let current: RegistrySnapshot = createRegistry().snapshot();
  let table: RegistryTable<Extension> | undefined;
  const publish = () => {
    try {
      const registry = createRegistry();
      for (const extension of [...(table?.values() ?? []), ...live.extensions()]) registry.install(extension);
      current = registry.snapshot();
    } catch (error) {
      report(error);
      return;
    }
    for (const listener of [...listeners]) listener();
  };
  // Chord hands the current table at once (chord `src/host.ts:805`), so the first snapshot has both.
  const stopTables = view.subscribe((next) => {
    table = next;
    publish();
  });
  const stopLive = live.subscribe(publish);
  return {
    snapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      stopTables();
      stopLive();
    },
  };
}
