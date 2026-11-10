import { basename } from 'node:path';

import * as chord from '@earendil-works/chord';
import type { Host, PluginFacet } from '@earendil-works/chord';
import * as chordContext from '@earendil-works/chord/context';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import * as chordJson from '@earendil-works/chord/json';
import { createPlugins, type Plugins } from '@earendil-works/chord/plugins';
import * as piAi from '@earendil-works/pi-ai';
import * as piDurable from '@earendil-works/pi-durable';
import * as piSchema from '@earendil-works/pi-schema';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';

import { InfiniChatTools } from './process';

/**
 * What a user's plugin may import besides its own files and the packages of its `dependencies`: this process's own
 * instances, so a plugin shares the host's Chord and pi (chord `src/node/plugins/README.md`, "host packages").
 */
const MODULES = {
  '@earendil-works/chord': chord,
  '@earendil-works/chord/context': chordContext,
  '@earendil-works/chord/json': chordJson,
  '@earendil-works/pi-ai': piAi,
  '@earendil-works/pi-durable': piDurable,
  '@earendil-works/pi-schema': piSchema,
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const listed = (what: string, names: readonly string[]) => names.length ? [`${what} ${names.join(', ')}`] : [];

/**
 * The plugins the user installs on this machine, outside the runtime so updates leave them be: each folder of
 * `folder` (`~/.infinichat/plugins`) with a `package.json`, whose `name` is the plugin's, and a `server.ts` (or
 * `.tsx`, `.js`, `.mjs`) whose default export is a facet, or a single file `<name>.server.ts` there. Chord's plugins
 * component finds them, builds each facet with esbuild, loads them beside the runtime's own facets, watches their
 * files and rolls a rebuilt one out (`src/node/plugins/README.md`, "For apps"); a plugin that fails to build or load
 * is left out, or keeps its old code at a reload. Reloads stay explicit: the user's `/reload-plugins`.
 */
export class ServerPlugins {
  private readonly plugins: Plugins;
  private reloading?: Promise<string>;

  constructor(private readonly host: Host<InfiniChatPrincipal>, folder: string) {
    this.plugins = createPlugins({
      roots: [{ path: folder, required: false }],
      kinds: { server: { platform: 'node', hostPackages: Object.keys(MODULES) } },
      onError: (error) => console.error('InfiniChat plugins:', error.kind, 'error' in error ? message(error.error) : ''),
    }, BACKGROUND_CONTEXT);
  }

  /**
   * Loads the runtime's own facets, `core`, and the user's plugins in one publication (chord `docs/design.md` §3,
   * `load`); returns what failed of the user's. A facet of the runtime that fails is a broken release.
   */
  async load(core: readonly PluginFacet<InfiniChatPrincipal>[]): Promise<string[]> {
    const report = await this.plugins.load(this.host, { kind: 'server', core, modules: MODULES }, BACKGROUND_CONTEXT);
    const broken = report.failed.find(({ plugin }) => core.some(({ name }) => name === plugin));
    if (broken !== undefined) throw new Error(`${broken.plugin} failed to load: ${message(broken.error)}`);
    return [...this.problems(), ...report.failed.map(({ plugin, error }) =>
      `Plugin ${plugin} failed to load: ${message(error)}`)];
  }

  /**
   * The user's `/reload-plugins`: builds the plugins whose files changed and those added since, rolls them out on
   * this host, where Chord restarts each object of a changed plugin and leaves the others (design §21), and has the
   * tools plugin read the MCP configuration again. Says what it did, for the app to show.
   */
  reload(): Promise<string> {
    // Two clients share the operation.
    this.reloading ??= this.run().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }

  close(): void {
    this.plugins.close();
  }

  /** The folders discovery could not take as plugins, such as one without a `package.json`. */
  private problems(): string[] {
    return this.plugins.discovery.problems.map(({ path, error }) => `Plugin folder ${basename(path)}: ${error}.`);
  }

  private async run(): Promise<string> {
    const context = BACKGROUND_CONTEXT;
    const lines: string[] = [];
    const built = await this.plugins.build(this.plugins.state.value.dirty, context);
    const { steps, stopped } = await this.plugins.rollout([this.plugins.step('server', this.host)], built, context);
    for (const step of steps) {
      for (const outcome of step.hosts) {
        if ('report' in outcome) {
          const { plugins: { added, changed, removed }, failed } = outcome.report;
          const done = [...listed('added', added), ...listed('reloaded', changed), ...listed('removed', removed)];
          lines.push(`Plugins: ${done.join('; ') || 'nothing changed'}.`);
          for (const { plugin, error } of failed) lines.push(`Plugin ${plugin} failed: ${message(error)}`);
        } else if ('error' in outcome) {
          lines.push(`The reload failed, and the plugins run as before: ${message(outcome.error)}`);
        }
      }
    }
    if (stopped !== undefined) lines.push(`The reload stopped: ${message(stopped.error)}`);
    lines.push(...this.problems());
    // In a root of its own: code outside objects calls one through a call scope (design §3, `root`).
    lines.push(await this.host.root(async (ctx) => (await ctx.get(InfiniChatTools, {})).mcp(ctx), context));
    return lines.join('\n');
  }
}
