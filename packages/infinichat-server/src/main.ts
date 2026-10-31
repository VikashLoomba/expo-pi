import { mkdir } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createHost, defineFacet } from '@earendil-works/chord';
import { nodeLoader, processLock } from '@earendil-works/chord/node';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { machineIdentity, PLUGIN } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';

import { listen } from './listen';
import { writeDiff, writePages, writePatch } from './pages';
import { ServerPlugins } from './plugins';
import { InfiniChatProcess } from './process';
import { restoreTimeZone } from './state';
import { installedRelease, ServerUpdates } from './update';

const USAGE = ['Usage: node main.js serve',
  '       node main.js pages <db> <out>',
  '       node main.js diff <db> <pages> <out> [--live]',
  '       node main.js patch <base> <patch> <out>'].join('\n');

/** The exit by which an update has the service manager start the new runtime (`update.ts`), EX_TEMPFAIL. */
const UPDATED = 75;

type End = { failed: unknown } | 'updated' | undefined;

/**
 * The Chord host of InfiniChat on this machine (chord `docs/guide.md` "Plugins"): it holds the process, its lock, its
 * clients' links and its updates, and loads InfiniChat's server plugin and the plugins the user installs, which serve
 * everything else. It runs until SIGTERM or SIGINT, an update of its runtime, or a storage error that ends the
 * conversation's Harness, which fails the process so its service manager starts it again: reopening is how
 * pi-durable recovers (README "Errors"). It names and describes the machine itself, as the apps' device lists do.
 */
async function serve(): Promise<number> {
  const home = join(homedir(), '.infinichat');
  // Node runs this module from its real path: the runtime's folder, beside the others (`install.ts`).
  const runtime = dirname(fileURLToPath(import.meta.url));
  const identity = await machineIdentity(new NodeExecutionEnv({ cwd: homedir() }), hostname(),
    new AbortController().signal);
  const device = identity.name;
  const description = machineDescription({ username: userInfo().username, hostname: identity.hostname });
  const stopping = Promise.withResolvers<End>();
  process.once('SIGTERM', () => stopping.resolve(undefined));
  process.once('SIGINT', () => stopping.resolve(undefined));
  // Opened in order and closed in reverse; every close runs, and the first failure is reported after the rest.
  const closes: (() => unknown)[] = [];
  try {
    // One process owns the storage; the lock follows that process, so it comes before anything opens storage.
    closes.push(await processLock('infinichat-server'));
    // It holds the conversation and the clients' secrets, which keep other local accounts out, so only this account
    // enters it.
    await mkdir(home, { recursive: true, mode: 0o700 });
    restoreTimeZone(home);
    const host = createHost<InfiniChatPrincipal>({
      name: 'infinichat-server', self: { kind: 'host' }, principalKey: (principal) => principal.kind,
      loader: nodeLoader,
    });
    // It disposes its objects, the conversation's among them, then closes its links.
    closes.push(() => host.close());
    const builtin = pathToFileURL(join(runtime, PLUGIN)).href;
    const plugins = new ServerPlugins(host, join(home, 'plugins'), join(runtime, 'node_modules'), [builtin]);
    // The process, for every plugin, before any loads.
    await host.install({
      name: 'infinichat.process',
      ...defineFacet<InfiniChatPrincipal>((api) => api.serve(InfiniChatProcess, () => ({
        process: {
          home, device, description,
          fail: (error: unknown) => stopping.resolve({ failed: error }),
          reloadPlugins: () => plugins.reload(),
        },
      }), { lifetime: 'host' })),
    });
    for (const failure of await plugins.load()) console.error(failure);
    const installed = await installedRelease(runtime);
    const server = await listen(host, home, installed?.version ?? INFINICHAT_SERVER_VERSION);
    // Stops accepting first; the host closes the connections already accepted.
    closes.push(() => server.close());
    if (installed !== undefined) {
      const updates = new ServerUpdates(dirname(runtime), runtime, installed, () => stopping.resolve('updated'));
      closes.push(() => updates.close());
      await updates.start();
    }
    const end = await stopping.promise;
    if (end === 'updated') return UPDATED;
    if (end !== undefined) console.error('InfiniChat storage failed:', end.failed);
    return end === undefined ? 0 : 1;
  } finally {
    let failure: unknown;
    for (const close of closes.reverse()) {
      try {
        await close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  }
}

async function main(args: string[]): Promise<number> {
  const { positionals: [command, ...paths], values } = parseArgs({ args, allowPositionals: true,
    options: { live: { type: 'boolean' } } });
  if (command === 'serve' && paths.length === 0) return serve();
  const [first, second, third] = paths;
  if (command === 'pages' && paths.length === 2) {
    await writePages(first, second);
  } else if (command === 'diff' && paths.length === 3) {
    await writeDiff(first, second, third, values.live === true);
  } else if (command === 'patch' && paths.length === 3) {
    await writePatch(first, second, third);
  } else {
    throw new Error(USAGE);
  }
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
