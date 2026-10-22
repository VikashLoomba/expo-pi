import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { createHost } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { processLock } from '@earendil-works/chord/node';
import type { SessionEnd } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

import type { InfiniChatPrincipal } from '../src/pi/infinichat-remote/contract';
import { InfiniChatService } from '../src/pi/infinichat-service';
import { serverDevices } from './devices';
import { listen } from './listen';
import { createServerModels } from './models';
import { serveInfiniChat } from './serve';

const USAGE = 'Usage: node server.js serve --device <name>';

/**
 * Runs InfiniChat on this machine until SIGTERM or SIGINT, or until a storage error ends its Harness, which fails the
 * process so its service manager starts it again: reopening is how pi-durable recovers (README "Errors").
 */
async function serve(device: string): Promise<number> {
  const home = join(homedir(), '.infinichat');
  const stopping = Promise.withResolvers<SessionEnd | undefined>();
  process.once('SIGTERM', () => stopping.resolve(undefined));
  process.once('SIGINT', () => stopping.resolve(undefined));
  // Opened in order and closed in reverse; every close runs, and the first failure is reported after the rest.
  const closes: (() => unknown)[] = [];
  try {
    // One process owns the storage; the lock follows that process, so it comes before anything opens storage.
    closes.push(await processLock('infinichat-server'));
    await mkdir(join(home, 'data'), { recursive: true });
    const storage = await openNodeSqliteStorage(join(home, 'data', 'infinichat.db'));
    // The Harness closes its storage; this closes it when the Harness never opened, and is a no-op otherwise.
    closes.push(() => storage.close(BACKGROUND_CONTEXT));
    const core = await InfiniChatService.open({
      storage, models: createServerModels(), devices: serverDevices(device),
      onClosed: (end) => {
        if (end.reason === 'failed') stopping.resolve(end);
      },
    });
    // Closing waits for running task code; work it cuts off stays pending for the next start.
    closes.push(() => core.close());
    const host = createHost<InfiniChatPrincipal>({
      name: 'infinichat-server', self: { kind: 'host' }, principalKey: (principal) => principal.kind,
    });
    // It disposes its objects, then closes its links.
    closes.push(() => host.close());
    serveInfiniChat(host, core);
    const server = await listen(host, home);
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

function main(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { device: { type: 'string' } } });
  if (positionals.length !== 1 || positionals[0] !== 'serve' || !values.device) throw new Error(USAGE);
  return serve(values.device);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
