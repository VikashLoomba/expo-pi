import { homedir } from 'node:os';
import { join } from 'node:path';

import { defineFacet } from '@earendil-works/chord';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { Type } from '@earendil-works/pi-ai';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';

import { InfiniChatTools } from './process';
import { Extensions, type ExtensionSource } from './registry';
import { mcpConfiguration, McpServer, serverExtensions } from './tools';

/** In InfiniChat's folder (`main.ts`). */
const CONFIG = join(homedir(), '.infinichat', 'mcp.json');

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const counted = (name: string, server: McpServer) =>
  `${name} (${server.tools.length} tool${server.tools.length === 1 ? '' : 's'})`;

/**
 * Code mode and the MCP servers of `~/.infinichat/mcp.json`: the tools plugin the runtime ships, which the host loads
 * after InfiniChat's and `/reload-plugins` reloads with the user's (`plugins.ts`). Its object reads the file on every
 * run and declares the code-mode sandbox and a resource per enabled server, versioned by what its connection is made
 * with, so a reload connects the servers added, reconnects those changed, closes those removed and leaves the others
 * connected (chord `docs/guide.md` "Declarations", "Hot reload"). Chord opens and closes them; Durable's phases
 * borrow them through the tools of their snapshots. A server's tools arrive after it connects and change when it says
 * so, while a registration changes only with a reload, so the object registers a live source in `Extensions`.
 * At shutdown the host disposes this object before or with InfiniChat's, whose Harness then aborts what still runs:
 * a script finds its sandbox closed and waits for that abort (durable `src/codemode/codemode.ts:481-491`), and a
 * server closes once its calls settle (`McpServer.retire`).
 */
export default defineFacet<InfiniChatPrincipal>((facet) => {
  facet.serve(InfiniChatTools, (_input, _principal, self) => {
    const { servers, problems } = mcpConfiguration(CONFIG);
    // A prepare reads the cell as the run before left it (chord `docs/spec.md` §7); this run's summary compares.
    const declared = self.state('servers', Type.Array(Type.String()), []);
    const previous = declared.value;
    // Once the run is live, never in a prepare a reload may abort; at a start, only the log has these.
    self.task(async (ctx) => {
      declared.replace(ctx, servers.map(({ name }) => name));
      for (const problem of problems) console.error('InfiniChat:', problem);
    });
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
        open: () => {
          opened.add(config.name);
          return new McpServer(config.name, config.connection);
        },
        close: (server) => server.retire(),
      }),
    }));
    // Resources are read when the Harness's registry reads the source, after the run's commit, never in a factory.
    const current = () => connections.map(({ config, resource }) => ({ config, server: resource.value }));
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
          const wasConnected = server.connected;
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
            reasons.push(`MCP server ${name} failed to connect: ${failure}`);
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
});
