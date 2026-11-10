import { mkdir } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createHost, type Facet, type HostError } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { processLock } from '@earendil-works/chord/workers/child';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { ServerHost, type InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { machineIdentity, PLUGIN } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';

import { listen } from './listen';
import { writeDiff, writePages, writePatch } from './pages';
import { ServerPlugins } from './plugins';
import type { ServerProcess } from './process';
import { restoreTimeZone } from './state';
import tools from './tools-facet';
import { installedRelease, ServerUpdates } from './update';

const USAGE = ['Usage: node main.js serve',
  '       node main.js pages <db> <out>',
  '       node main.js diff <db> <pages> <out> [--live]',
  '       node main.js patch <base> <patch> <out>'].join('\n');

/** The exit by which an update has the service manager start the new runtime (`update.ts`), EX_TEMPFAIL. */
const UPDATED = 75;
type End = { failed: unknown } | 'updated' | undefined;

const text = (error: unknown) => error instanceof Error ? error.message : String(error);

/** What the host reports of its background, for the service's log (chord `docs/design.md` §3, `onError`). */
function hostError(error: HostError): string {
  if ('message' in error) return `${error.kind}: ${error.message}`;
  const subject = 'object' in error ? ` ${error.object}` : '';
  return `${error.kind}${subject}${'error' in error ? `: ${text(error.error)}` : ''}`;
}

/** InfiniChat's plugin as its module exports it: the facet, made from the process (`facet.ts`). */
type ProcessPlugin = (process: ServerProcess) => Facet<InfiniChatPrincipal>;
const isProcessPlugin = (value: unknown): value is ProcessPlugin => typeof value === 'function';

/** InfiniChat's server plugin, the one module a release replaces without its runtime (`update.ts`). */
async function infiniChatPlugin(path: string): Promise<ProcessPlugin> {
  const module: unknown = await import(pathToFileURL(path).href);
  if (typeof module === 'object' && module !== null && 'default' in module && isProcessPlugin(module.default)) {
    return module.default;
  }
  throw new Error(`${path} is not InfiniChat’s server plugin.`);
}

/**
 * The Chord host of InfiniChat on this machine, its links' one server (chord `docs/design.md` §3, "The low-level host
 * API"): it holds the process, its lock, its clients' links and its updates, and loads InfiniChat's server plugin, the
 * tools plugin and the plugins the user installs, which serve everything else. It runs until SIGTERM or SIGINT, an
 * update of its runtime, or a storage error that ends the conversation's Harness, which fails the process so its
 * service manager starts it again: reopening is how pi-durable recovers (README "Errors"). It names and describes the
 * machine itself, as the apps' device lists do.
 */
async function serve(): Promise<number> {
  const context = BACKGROUND_CONTEXT;
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
    const lock = await processLock('infinichat-server', context);
    closes.push(() => lock.release());
    // It holds the conversation and the clients' secrets, which keep other local accounts out, so only this account
    // enters it.
    await mkdir(home, { recursive: true, mode: 0o700 });
    restoreTimeZone(home);
    // Addressable, so it serves the types clients hold; it acts as itself on its own objects (design §3, §4).
    const host = createHost<InfiniChatPrincipal>({
      address: ServerHost(), principal: { kind: 'host' }, principalKey: (principal) => principal.kind,
      // Chord never ends the process: what fails in the background is the log's, and the objects retry.
      onError: (error) => console.error('InfiniChat:', hostError(error)),
    });
    // It closes its links, then ends its objects, the conversation's among them.
    closes.push(() => host.close(context));
    // The user's plugins folder exists before the component watches it, so one added later is found.
    await mkdir(join(home, 'plugins'), { recursive: true, mode: 0o700 });
    const plugins = new ServerPlugins(host, join(home, 'plugins'));
    closes.push(() => plugins.close());
    const loaded = Promise.withResolvers<void>();
    const proc: ServerProcess = {
      home, device, description, loaded: loaded.promise,
      fail: (error: unknown) => stopping.resolve({ failed: error }),
      reloadPlugins: () => plugins.reload(),
    };
    const infinichat = await infiniChatPlugin(join(runtime, PLUGIN));
    // InfiniChat's and the tools plugin, then the user's, in one publication. Only a release changes the first two,
    // so `/reload-plugins` passes them as they are.
    const failures = await plugins.load([
      { name: '@infinichat/core', facet: infinichat(proc) }, { name: '@infinichat/tools', facet: tools() },
    ]);
    for (const failure of failures) console.error(failure);
    // Durable resumes once every extension is installed (its `docs/spec.md` §2.2), as chord's design has base code
    // resume after `host.load` (`docs/design.md` §24), so a tool call a restart cut off finds its tool and reruns.
    loaded.resolve();
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
