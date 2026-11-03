import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defineFacet } from '@earendil-works/chord';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { arr, str } from '@earendil-works/pi-schema';
import { fileCredentialBackend } from '@pi-agent/infinichat/node/credentials';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import {
  InfiniChatMcp, McpServerStatusSchema, McpSignInAttemptSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { MACHINE_WORK } from '@pi-agent/infinichat/pi/infinichat/device-tools';

import { mcpConfiguration } from './mcp-config';
import { McpLog } from './mcp-log';
import { McpServer } from './mcp-server';
import { McpRegistry, McpServers } from './mcp-servers';
import { serverExtensions } from './mcp-tools';
import { InfiniChatTools } from './process';
import { Extensions, type ExtensionSource } from './registry';

/** InfiniChat's folder (`main.ts`), with the MCP configuration, credentials and log. */
const HOME = join(homedir(), '.infinichat');
const CONFIG = join(HOME, 'mcp.json');
/**
 * The folder the agents' tools run under (`node/devices.ts`), the roots the servers are given, as the coding agent gives
 * its session's (`src/extensions/mcp/runtime.ts:364`).
 */
const WORK = join(homedir(), MACHINE_WORK);
const ROOTS = [{ uri: pathToFileURL(WORK).href, name: 'work' }];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const counted = (name: string, server: McpServer) =>
  `${name} (${server.tools.length} tool${server.tools.length === 1 ? '' : 's'})`;

/**
 * A member of a live object, which Chord reads as `undefined` until it is live (chord `src/object.ts`, `expose`); read
 * where the references it depends on are live.
 */
function live<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not live yet.`);
  return value;
}

/**
 * Code mode and the MCP servers of `~/.infinichat/mcp.json`: the tools plugin the runtime ships, which the host loads
 * after InfiniChat's and `/reload-plugins` reloads with the user's (`plugins.ts`). Three objects (chord `docs/guide.md`
 * "Plugins"): the registry, which holds what outlives a run of the configuration (credentials, the log, sign-ins); the
 * tools object, which reads the file on every run and declares the code-mode sandbox and a resource per enabled
 * server, versioned by what its connection is made with, so a reload connects the servers added, reconnects those
 * changed, closes those removed and leaves the others connected ("Declarations", "Hot reload"); and `/mcp`'s object,
 * which clients hold. Chord opens and closes the connections; Durable's phases borrow them through the tools of their
 * snapshots. A server's tools arrive after it connects and change when it says so, while a registration changes only
 * with a reload, so the tools object registers a live source in `Extensions`. At shutdown the host disposes these
 * objects before or with InfiniChat's, whose Harness then aborts what still runs: a script finds its sandbox closed
 * and waits for that abort (durable `src/codemode/codemode.ts:483-493`), and a server closes once its requests settle
 * (`McpServer.retire`).
 */
export default defineFacet<InfiniChatPrincipal>((facet) => {
  facet.serve(McpRegistry, (_input, _principal, self) => {
    const servers = self.resource('servers', {
      version: 1,
      // One backend for the file, so its writes run one at a time (`node/credentials.ts`).
      open: () => new McpServers(fileCredentialBackend(join(HOME, 'mcp-auth.json')), new McpLog(join(HOME, 'mcp.log'))),
      close: (registry) => registry.close(),
    });
    return { servers: self.expose(servers) };
  }, { lifetime: 'host' });

  facet.serve(InfiniChatTools, (_input, _principal, self) => {
    const { servers, disabled, problems } = mcpConfiguration(CONFIG);
    const registry = self.get(McpRegistry, {});
    const mcp = () => live(registry.servers, 'The MCP registry');
    // A prepare reads the cell as the run before left it (chord `docs/spec.md` §7); this run's summary compares.
    const declared = self.state('servers', arr(str()), []);
    const previous = declared.value;
    // A run opens the resources added or changed since the run before; Chord keeps the others open.
    const opened = new Set<string>();
    const sandbox = self.resource('sandbox', {
      version: 1,
      open: () => new CodemodeSandbox(),
      close: (value) => value.close(),
    });
    const connections = servers.map((config) => ({
      config,
      resource: self.resource(`mcp__${config.name}`, {
        version: config.version,
        deps: [registry],
        open: () => {
          opened.add(config.name);
          const { connection } = config;
          const oauth = 'url' in connection && connection.oauth !== undefined ? {
            serverUrl: connection.url, settings: connection.oauth,
            credentials: mcp().credentials(config.name, connection.url),
          } : undefined;
          return new McpServer(config.name, connection, oauth, mcp().log, ROOTS);
        },
        close: (server) => server.retire(),
      }),
    }));
    // Resources are read when the Harness's registry reads the source, after the run's commit, never in a factory.
    const current = () => connections.map(({ config, resource }) => ({ config, server: resource.value }));
    // Once the run is live, never in a prepare a reload may abort; at a start, only the log has these.
    self.task(async (ctx) => {
      declared.replace(ctx, servers.map(({ name }) => name));
      mcp().update(current(), disabled, problems);
      for (const problem of problems) console.error('InfiniChat:', problem);
    });
    const source: ExtensionSource = {
      extensions: () => serverExtensions(sandbox.value, current()),
      subscribe(listener) {
        const stops = current().map(({ server }) => server.subscribe(listener));
        return () => {
          for (const stop of stops) stop();
        };
      },
    };
    self.register(Extensions, { 'infinichat.server-tools': source });
    return {
      // A server that is left as it was but isn't connected, such as one that was down, connects again here.
      mcp: async () => {
        const outcomes = await Promise.all(current().map(async ({ config: { name }, server }) => {
          const wasConnected = server.state === 'connected';
          const failure = await server.connect().then(() => undefined, message);
          return { name, server, wasConnected, failure };
        }));
        const connected: string[] = [];
        const reconnected: string[] = [];
        const unchanged: string[] = [];
        const failed: string[] = [];
        const reasons: string[] = [];
        for (const { name, server, wasConnected, failure } of outcomes) {
          if (failure !== undefined) {
            failed.push(name);
            reasons.push(failure);
          } else if (opened.has(name) && previous.includes(name)) {
            reconnected.push(counted(name, server));
          } else if (opened.has(name) || !wasConnected) {
            connected.push(counted(name, server));
          } else {
            unchanged.push(name);
          }
        }
        const closed = previous.filter((name) => !servers.some((server) => server.name === name));
        const done = Object.entries({ connected, reconnected, closed, failed, unchanged })
          .filter(([, names]) => names.length > 0).map(([what, names]) => `${what} ${names.join(', ')}`);
        return [`MCP: ${done.join('; ') || 'no servers'}.`, ...reasons, ...problems].join('\n');
      },
    };
  }, { lifetime: 'host' });

  /**
   * `/mcp` as clients hold it, one object every client shares (all act as the owner): the registry's servers, what the
   * configuration skipped, and its sign-in under way, mirrored into cells; its operations go to the registry.
   */
  facet.serve(InfiniChatMcp, (_input, _principal, self) => {
    const registry = self.get(McpRegistry, {});
    const servers = self.resource('servers', { version: 1, deps: [registry],
      open: () => live(registry.servers, 'The MCP registry') });
    const signIns = self.resource('signIns', { version: 1, deps: [registry],
      open: () => live(registry.servers, 'The MCP registry').signIns });
    const list = self.state('servers', arr(McpServerStatusSchema), { init: () => servers.value.statuses() });
    const problems = self.state('problems', arr(str()), { init: () => servers.value.problems() });
    const signInAttempt = self.state('signInAttempt', McpSignInAttemptSchema,
      { init: () => signIns.value.getSnapshot() });
    self.on('servers', servers, (_change, ctx) => {
      list.replace(ctx, servers.value.statuses(), { diff: true });
      problems.replace(ctx, servers.value.problems(), { diff: true });
    });
    self.on('signInAttempt', signIns, (_change, ctx) => signInAttempt.replace(ctx, signIns.value.getSnapshot()));
    return {
      variant: 'owner',
      servers: list,
      problems,
      signInAttempt,
      signIn: ({ server }) => servers.value.signIn(server),
      answer: ({ promptId, value }) => servers.value.answer(promptId, value),
      cancelSignIn: () => servers.value.cancelSignIn(),
      signOut: ({ server }) => servers.value.signOut(server),
      reconnect: ({ server }) => servers.value.reconnect(server),
    };
  });
});
