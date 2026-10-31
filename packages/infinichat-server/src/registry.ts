import { defineRegistry, type RegistryTable, type RegistryView } from '@earendil-works/chord';
import {
  createRegistry, type Extension, type RegistryReader, type RegistrySnapshot,
} from '@earendil-works/pi-durable';

/**
 * A plugin whose Durable extensions also change between code reloads, such as MCP discovery. Chord owns the
 * registration; its resource owns the connections. The source is rebuilt by the facet, not retained as resource code.
 * A reload explicitly refreshes configuration; unchanged Chord resources do not reopen on a code reload.
 */
export interface ExtensionSource {
  extensions(): readonly Extension[];
  subscribe(listener: () => void): () => void;
  reload(validate: (extensions: readonly Extension[]) => void): Promise<string>;
}

export type ExtensionContribution = Extension | ExtensionSource;

/**
 * Durable extensions contributed by host-lifetime plugin objects through `self.register(Extensions, ...)`, following
 * Chord's Durable guide. Static extensions and live sources share this table: no built-in is appended after plugins.
 */
export const Extensions = defineRegistry<ExtensionContribution>('infinichat.extensions');

export const isExtensionSource = (value: ExtensionContribution): value is ExtensionSource => 'extensions' in value;

/** Build before publishing: a rejected contribution leaves the Harness's previous complete snapshot in use. */
export function extensionSnapshot(table: RegistryTable<ExtensionContribution>, replacement?: {
  source: ExtensionSource; extensions: readonly Extension[];
}): RegistrySnapshot {
  const registry = createRegistry();
  const names = new Set<string>();
  for (const contribution of table.values()) {
    const extensions = contribution === replacement?.source ? replacement.extensions
      : isExtensionSource(contribution) ? contribution.extensions() : [contribution];
    for (const extension of extensions) {
      // Durable replaces by name for reload; two different contributors must not silently replace one another.
      if (names.has(extension.name)) throw new Error(`More than one plugin contributes extension ${extension.name}.`);
      names.add(extension.name);
      registry.install(extension);
    }
  }
  return registry.snapshot();
}

/**
 * One immutable Durable snapshot per Chord table or live-source change. Durable pins it for a phase; subsequent
 * phases see the next publication (durable test/examples/10-registry-reload.ts). The reader and Harness stay open.
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
