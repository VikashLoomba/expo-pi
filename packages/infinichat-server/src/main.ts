import { mkdir } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createHost } from '@earendil-works/chord';
import { processLock } from '@earendil-works/chord/node';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import type { SessionEnd } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { fileCredentialBackend, openAILoginOptions } from '@pi-agent/infinichat/node/credentials';
import { serverDevices } from '@pi-agent/infinichat/node/devices';
import { ServerMachines } from '@pi-agent/infinichat/node/machines';
import { ServerSignIn } from '@pi-agent/infinichat/node/sign-in';
import { createServerModels } from '@pi-agent/infinichat/node/models';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { machineIdentity } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';
import { machineDescription } from '@pi-agent/infinichat/pi/infinichat/device-tools';
import { validateOpenAICredential } from '@pi-agent/infinichat/pi/openai-auth/core';
import { ProviderCredentialStore } from '@pi-agent/infinichat/pi/provider-credentials';

import { ServerConversation } from './conversation';
import { listen } from './listen';
import { writeDiff, writePages, writePatch } from './pages';
import { serveInfiniChat } from './serve';
import { restoreTimeZone, setTimeZone } from './state';
import { ServerUpdates } from './update';

const USAGE = ['Usage: node server.js serve',
  '       node server.js pages <db> <out>',
  '       node server.js diff <db> <pages> <out> [--live]',
  '       node server.js patch <base> <patch> <out>'].join('\n');

// pi-ai loads its sign-in flows through an import bundlers cannot follow, which this single-file bundle cannot resolve
// at run time, so it registers them statically at startup, as pi's own standalone binary does (coding-agent
// `src/bun/runtime-setup.ts:10` at v1.4.0). The flows use only `node:http` and `node:crypto`.
registerBunOAuthFlows();

/** The exit by which an update has the service manager start the new release (`update.ts`), EX_TEMPFAIL. */
const UPDATED = 75;

/**
 * Runs InfiniChat on this machine until SIGTERM or SIGINT, an update, or a storage error that ends its Harness, which
 * fails the process so its service manager starts it again: reopening is how pi-durable recovers (README "Errors").
 * It names and describes the machine itself, as the apps' device lists do.
 */
async function serve(): Promise<number> {
  const home = join(homedir(), '.infinichat');
  const identity = await machineIdentity(new NodeExecutionEnv({ cwd: homedir() }), hostname(),
    new AbortController().signal);
  const device = identity.name;
  const description = machineDescription({ username: userInfo().username, hostname: identity.hostname });
  const stopping = Promise.withResolvers<SessionEnd | 'updated' | undefined>();
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
    // pi-ai's own persistence seam: this machine's store, for as long as the process; its file outlives it.
    const backend = fileCredentialBackend(join(home, 'credentials.json'));
    const credentials = new ProviderCredentialStore(backend, { openai: { validate: validateOpenAICredential } },
      `Check that ~/.infinichat/credentials.json on ${device} can be read and written, then try again.`);
    const models = createServerModels(credentials);
    credentials.registerProviders(models.getProviders().map((provider) => provider.id));
    // A provider whose credential cannot be read reports it in its own access state.
    await credentials.restore().catch(() => {});
    // pi.dev's newer models before InfiniChat opens, so work it resumes finds a model pi-ai doesn't ship
    // (`chat-providers.ts`); each fetch waits at most pi's own 4 s, and a provider whose fetch fails keeps pi-ai's.
    await models.refresh();
    const signIn = new ServerSignIn(models, credentials, openAILoginOptions(backend));
    // Ends an attempt still under way, after the host has closed the links that could start another.
    closes.push(() => signIn.cancel());
    // The other machines' connections close after the conversation, whose tools use them, as the phone's provider
    // closes its remote owner after both Harnesses.
    const machines = new ServerMachines(home, device);
    closes.push(() => machines.close());
    // Open only while this machine holds the conversation; the phone moves it here and back.
    const conversation = new ServerConversation(home, (storage) => InfiniChatService.open({
      storage, models, devices: serverDevices(device, description, machines), machine: device,
      onClosed: (end) => {
        if (end.reason === 'failed') stopping.resolve(end);
      },
    }));
    // The machines are the open conversation's document; the connections follow it and outlive each hold.
    const unfollow = machines.follow({
      subscribe: conversation.subscribe, current: () => conversation.current?.machines.getSnapshot(),
    });
    closes.push(async () => unfollow());
    await conversation.start();
    // Closing waits for running task code; work it cuts off stays pending for the next start.
    closes.push(() => conversation.close());
    const host = createHost<InfiniChatPrincipal>({
      name: 'infinichat-server', self: { kind: 'host' }, principalKey: (principal) => principal.kind,
    });
    // It disposes its objects, then closes its links.
    closes.push(() => host.close());
    serveInfiniChat(host, conversation, {
      server: { version: INFINICHAT_SERVER_VERSION }, device, setTimeZone: (zone) => setTimeZone(home, zone),
      models, credentials, signIn, machines,
    });
    const server = await listen(host, home, INFINICHAT_SERVER_VERSION);
    // Stops accepting first; the host closes the connections already accepted.
    closes.push(() => server.close());
    // Node runs the bundle from its real path, so its folder is this release's, beside the others (`install.ts`).
    const release = dirname(fileURLToPath(import.meta.url));
    const updates = new ServerUpdates(dirname(release), basename(release), INFINICHAT_SERVER_VERSION,
      () => stopping.resolve('updated'));
    closes.push(() => updates.close());
    await updates.start();
    const end = await stopping.promise;
    if (end === 'updated') return UPDATED;
    if (end?.reason === 'failed') console.error('InfiniChat storage failed:', end.error);
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
