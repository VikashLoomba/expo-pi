import { defineRegistry, type RegistryTable, type RegistryView } from '@earendil-works/chord';
import {
  createRegistry, type Extension, type RegistryReader, type RegistrySnapshot,
} from '@earendil-works/pi-durable';

/**
 * Extensions that change while their plugin's code doesn't, such as an MCP server's tools once it has listed them:
 * pi-durable's registry is the application's and may change while the Harness runs, new work using the new state
 * (durable `docs/spec.md` §7.4-7.5), while a Chord registration changes only when code is committed. Its plugin
 * registers it as it registers an extension, so a reload or removal of the plugin replaces or withdraws it.
 */
export interface ExtensionSource {
  extensions(): readonly Extension[];
  subscribe(listener: () => void): () => void;
}

export type ExtensionContribution = Extension | ExtensionSource;

/**
 * The Durable extensions a server's plugins contribute for its Harness: InfiniChat's own, the tools plugin's and any
 * plugin the user installs (chord `docs/guide.md` "Durable"). A plugin registers with `self.register(Extensions, …)`
 * from an object of lifetime `"host"`; a token of this name in its own module is the same registry.
 */
export const Extensions = defineRegistry<ExtensionContribution>('infinichat.extensions');

export const isExtensionSource = (value: ExtensionContribution): value is ExtensionSource => 'extensions' in value;

/**
 * One complete Durable snapshot of `table`, its sources' extensions as they are now. pi-durable builds and validates a
 * snapshot as a registry installs, so each gets a registry of its own.
 */
export function extensionSnapshot(table: RegistryTable<ExtensionContribution>): RegistrySnapshot {
  const registry = createRegistry();
  const names = new Set<string>();
  for (const contribution of table.values()) {
    for (const extension of isExtensionSource(contribution) ? contribution.extensions() : [contribution]) {
      // Durable replaces by name for reload; two different contributors must not silently replace one another.
      if (names.has(extension.name)) throw new Error(`More than one plugin contributes extension ${extension.name}.`);
      names.add(extension.name);
      registry.install(extension);
    }
  }
  return registry.snapshot();
}

/**
 * Durable's `RegistryReader` over the tables of `Extensions`, which Chord leaves to the application (chord
 * `docs/spec.md` §8): one complete snapshot per code version and per change of a source in it, so a Durable phase pins
 * a whole one and a reload never shows a moment without an extension (durable `test/examples/10-registry-reload.ts`).
 * One pi-durable refuses, such as two plugins' tasks of one name, is reported and the last snapshot stays.
 */
export function durableRegistry(view: RegistryView<ExtensionContribution>, report: (error: unknown) => void):
RegistryReader & { close(): void } {
  const listeners = new Set<() => void>();
  let current: RegistrySnapshot = createRegistry().snapshot();
  let table: RegistryTable<ExtensionContribution> = new Map();
  let subscriptions: (() => void)[] = [];
  const publish = () => {
    try {
      current = extensionSnapshot(table);
    } catch (error) {
      report(error);
      return;
    }
    for (const listener of [...listeners]) listener();
  };
  // Chord hands the current table at once (chord `src/host.ts:805`), and each one a commit swaps in.
  const stopTables = view.subscribe((next) => {
    for (const stop of subscriptions) stop();
    table = next;
    subscriptions = [];
    for (const contribution of table.values()) {
      if (isExtensionSource(contribution)) subscriptions.push(contribution.subscribe(publish));
    }
    publish();
  });
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
      for (const stop of subscriptions) stop();
      listeners.clear();
    },
  };
}
