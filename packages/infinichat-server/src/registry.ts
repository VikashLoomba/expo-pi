import { defineRegistry, type ComposeContext, type RegistryTable } from '@earendil-works/chord';
import { createRegistry, type Extension, type RegistrySnapshot } from '@earendil-works/pi-durable';

/**
 * The Durable extensions a server's plugins contribute for its Harness, composed into Durable's registry snapshot, as
 * pi-durable's `test/examples/37-harness-registry.ts` has it: InfiniChat's own, the tools plugin's and any plugin the
 * user installs. A contributor has one value per registry (chord `docs/design.md` §17), so each contributes a list:
 * a facet with `self.contribute(Extensions, [...])`, or an object that lives as long as the host with a watchable of
 * one, whose every change composes again, as an MCP server's tools do once it has listed them. A token of this name
 * and version in a plugin's own module is the same registry.
 */
export const Extensions = defineRegistry<readonly Extension[], RegistrySnapshot>('infinichat.extensions',
  { version: 1 });

/**
 * One complete Durable snapshot of `table`. Chord orders the table by plugin name, so of two plugins contributing an
 * extension of one name the first by name is installed, and the other is reported and left out, as is one pi-durable
 * refuses, such as a task name taken: a composition always delivers a value (design §17).
 */
export function composeExtensions(table: RegistryTable<readonly Extension[]>, { report }: ComposeContext,
): RegistrySnapshot {
  const registry = createRegistry();
  const owners = new Map<string, string>();
  for (const { plugin, value } of table) {
    for (const extension of value) {
      const owner = owners.get(extension.name);
      if (owner !== undefined) {
        // Durable replaces by name for reload; two contributors must not silently replace one another.
        report({ message: `More than one plugin contributes extension ${extension.name}; ${owner}’s is used.`,
          plugins: [owner, plugin] });
        continue;
      }
      try {
        registry.install(extension);
        owners.set(extension.name, plugin);
      } catch (error) {
        report({ message: error instanceof Error ? error.message : String(error), plugins: [plugin] });
      }
    }
  }
  return registry.snapshot();
}
