import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { createHost } from '@earendil-works/chord';
import { processLock } from '@earendil-works/chord/node';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import type { SessionEnd } from '@earendil-works/pi-durable';
import { fileCredentialBackend } from '@pi-agent/infinichat/node/credentials';
import { serverDevices } from '@pi-agent/infinichat/node/devices';
import { ServerMachines } from '@pi-agent/infinichat/node/machines';
import { createServerModels } from '@pi-agent/infinichat/node/models';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';
import { buildModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';
import { validateOpenAICredential } from '@pi-agent/infinichat/pi/openai-auth/core';
import { ProviderCredentialStore } from '@pi-agent/infinichat/pi/provider-credentials';

import { ServerConversation } from './conversation';
import { openAILoginOptions } from './credentials';
import { listen } from './listen';
import { writeDiff, writePages, writePatch } from './pages';
import { serveInfiniChat } from './serve';
import { ServerSignIn } from './sign-in';
import { restoreTimeZone, setTimeZone } from './state';

const USAGE = ['Usage: node server.js serve --device <name> --description <text>',
  '       node server.js pages <db> <out>',
  '       node server.js diff <db> <pages> <out> [--live]',
  '       node server.js patch <base> <patch> <out>'].join('\n');

// pi-ai loads its sign-in flows through an import bundlers cannot follow, which this single-file bundle cannot resolve
// at run time, so it registers them statically at startup, as pi's own standalone binary does (coding-agent
// `src/bun/runtime-setup.ts:10` at v1.4.0). The flows use only `node:http` and `node:crypto`.
registerBunOAuthFlows();

/**
 * Runs InfiniChat on this machine until SIGTERM or SIGINT, or until a storage error ends its Harness, which fails the
 * process so its service manager starts it again: reopening is how pi-durable recovers (README "Errors").
 */
async function serve(device: string, description: string): Promise<number> {
  const home = join(homedir(), '.infinichat');
  const stopping = Promise.withResolvers<SessionEnd | undefined>();
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
    await conversation.start();
    // Closing waits for running task code; work it cuts off stays pending for the next start.
    closes.push(() => conversation.close());
    const host = createHost<InfiniChatPrincipal>({
      name: 'infinichat-server', self: { kind: 'host' }, principalKey: (principal) => principal.kind,
    });
    // It disposes its objects, then closes its links.
    closes.push(() => host.close());
    // The phone installs each bundle in a directory named after its hash.
    const bundle = basename(dirname(fileURLToPath(import.meta.url)));
    serveInfiniChat(host, conversation, {
      server: { bundle, pi: INFINICHAT_PI, device, description }, setTimeZone: (zone) => setTimeZone(home, zone),
      catalog: buildModelCatalog(models), credentials, signIn, machines,
    });
    const server = await listen(host, home, bundle);
    // Stops accepting first; the host closes the connections already accepted.
    closes.push(() => server.close());
    const end = await stopping.promise;
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
    options: { device: { type: 'string' }, description: { type: 'string' }, live: { type: 'boolean' } } });
  if (command === 'serve' && paths.length === 0 && values.device && values.description) {
    return serve(values.device, values.description);
  }
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
