import { access, lstat, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { Host } from '@earendil-works/chord';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';

/** A plugin's server facet, the first of these its folder has: Node strips TypeScript's types as it loads. */
const ENTRIES = ['server.ts', 'server.mts', 'server.js', 'server.mjs'];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A facet's name is its module's URL (chord `src/loader.ts`); the user knows it by its folder. */
const nameOf = (url: string) => basename(dirname(fileURLToPath(url)));

/**
 * The plugins the user installs on this machine, outside the runtime so updates leave them be: each folder in
 * `folder` (`~/.infinichat/plugins`) with a server facet (chord `docs/guide.md` "Plugins"), loaded after InfiniChat's
 * own. Their imports of Chord, pi and TypeBox resolve through `node_modules` there, a link to the runtime's
 * `modules`, so a plugin shares the host's single instances, which Chord's loader keeps outside a facet's folder
 * (chord `src/loader.ts:17-21`).
 */
export class ServerPlugins {
  /** The facets loaded, by name. */
  private readonly loaded = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: Host<InfiniChatPrincipal>, private readonly folder: string,
    private readonly modules: string) {}

  /** Loads each plugin on its own, so one that fails leaves the others; returns the failures. */
  load(): Promise<string[]> {
    return this.run(async () => {
      const failed: string[] = [];
      for (const url of await this.found()) {
        try {
          await this.host.load([url]);
          this.loaded.add(url);
        } catch (error) {
          failed.push(`Plugin ${nameOf(url)} failed to load: ${message(error)}`);
        }
      }
      return failed;
    });
  }

  /**
   * Chord's explicit reload (`docs/spec.md` §7), which the user runs from an app's `/reload-plugins`: the plugins
   * still there in one reload, which removes those whose folder is gone, then each plugin added since. What it did,
   * for the app to show.
   */
  reload(): Promise<string> {
    return this.run(async () => {
      const found = await this.found();
      const gone = [...this.loaded].filter((url) => !found.includes(url));
      const kept = found.filter((url) => this.loaded.has(url));
      const lines: string[] = [];
      if (kept.length > 0 || gone.length > 0) {
        try {
          const report = await this.host.reload(kept, { remove: gone });
          for (const url of gone) this.loaded.delete(url);
          const removed = gone.length ? `; removed ${gone.map(nameOf).join(', ')}` : '';
          lines.push(`Reloaded ${kept.map(nameOf).join(', ') || 'no plugin'}; changed types: `
            + `${report.changed.join(', ') || 'none'}${removed}.`);
        } catch (error) {
          lines.push(`The reload was refused, and the plugins run as before: ${message(error)}`);
        }
      }
      for (const url of found.filter((candidate) => !this.loaded.has(candidate))) {
        try {
          await this.host.load([url]);
          this.loaded.add(url);
          lines.push(`Loaded ${nameOf(url)}.`);
        } catch (error) {
          lines.push(`Plugin ${nameOf(url)} failed to load: ${message(error)}`);
        }
      }
      return lines.join('\n') || `No plugins are installed in ${this.folder}.`;
    });
  }

  /** One load or reload at a time, as Chord serializes reloads. */
  private run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      await this.link();
      return step();
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async found(): Promise<string[]> {
    const urls: string[] = [];
    for (const entry of await readdir(this.folder, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      for (const file of ENTRIES) {
        const path = join(this.folder, entry.name, file);
        if (await access(path).then(() => true, () => false)) {
          urls.push(pathToFileURL(path).href);
          break;
        }
      }
    }
    return urls;
  }

  /**
   * The plugins folder, and its link to the runtime's packages, which a runtime update moves. A `node_modules` the
   * user made there is theirs: their plugins then load their own copies.
   */
  private async link(): Promise<void> {
    await mkdir(this.folder, { recursive: true, mode: 0o700 });
    const link = join(this.folder, 'node_modules');
    const found = await lstat(link).catch(() => undefined);
    if (found !== undefined && !found.isSymbolicLink()) return;
    if (found !== undefined && await readlink(link) === this.modules) return;
    await rm(link, { force: true });
    await symlink(this.modules, link);
  }
}
