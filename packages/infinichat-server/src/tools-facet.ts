import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { defineFacet, untilAborted } from '@earendil-works/chord';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import type { Extension } from '@earendil-works/pi-durable';
import { fileCredentialBackend } from '@pi-agent/infinichat/node/credentials';
import type { InfiniChatPrincipal } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import {
  InfiniChatMcp, type McpServerStatus, type McpSignInAttempt,
} from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { MACHINE_WORK } from '@pi-agent/infinichat/pi/infinichat/device-tools';

import { mcpConfiguration } from './mcp-config';
import { McpLog } from './mcp-log';
import { McpServers } from './mcp-servers';
import { serverExtensions } from './mcp-tools';
import { done, InfiniChatTools } from './process';
import { Extensions } from './registry';

/** InfiniChat's folder (`main.ts`), with the MCP configuration, credentials and log. */
const HOME = join(homedir(), '.infinichat');
const CONFIG = join(HOME, 'mcp.json');
/**
 * The folder the agents' tools run under (`node/devices.ts`), the roots the servers are given, as the coding agent gives
 * its session's (`src/extensions/mcp/runtime.ts:364`).
 */
const WORK = join(homedir(), MACHINE_WORK);
const ROOTS = [{ uri: pathToFileURL(WORK).href, name: 'work' }];

/** `/mcp`'s state, published together. */
interface McpView { servers: McpServerStatus[]; problems: string[]; signInAttempt: McpSignInAttempt }
const NO_SERVERS: McpView = { servers: [], problems: [], signInAttempt: null };

const report = (error: unknown) => console.error('InfiniChat:', error instanceof Error ? error.message : error);

/**
 * Code mode and the MCP servers of `~/.infinichat/mcp.json`: the tools plugin the runtime ships, which the host loads
 * with InfiniChat's (`main.ts`). One object for the host's life owns the natives (chord `docs/design.md` §13): the
 * code-mode sandbox, and the servers with their credentials, log and sign-ins (`McpServers`), which applies the
 * configuration at the start and whenever `mcp` is called, as `/reload-plugins` does: this plugin's code changes only
 * with a release, and Chord's reload restarts only the objects of changed plugins (§21). Durable's phases borrow the
 * connections through the tools of their snapshots. A server's tools arrive after it connects and change when it says
 * so, so the object contributes a list it sets again at each change (§17, "contributions may be readables"). The type
 * clients hold, `/mcp`'s, re-exposes the object's members (§6, "shared store, per-principal views"). At shutdown the
 * host closes these natives before or with InfiniChat's, whose Harness then aborts what still runs: a script finds its
 * sandbox closed and waits for that abort (durable `src/codemode/codemode.ts`), and a server closes once its requests
 * settle (`McpServer.retire`). `version` is the release the servers are told is connecting, InfiniChat's plugin's.
 */
export default (version: string) => defineFacet<InfiniChatPrincipal>((host) => {
  host.serve(InfiniChatTools, (_params, self) => {
    const sandbox = self.open(async () => new CodemodeSandbox(), (value) => value.close());
    // One backend for the file, so its writes run one at a time (`node/credentials.ts`).
    const servers = self.open(async () => new McpServers(fileCredentialBackend(join(HOME, 'mcp-auth.json')),
      new McpLog(join(HOME, 'mcp.log')), ROOTS, version), (opened) => opened.close());
    const extensions = self.writable<readonly Extension[]>([]);
    self.contribute(Extensions, extensions);
    const shown = self.writable(NO_SERVERS);
    self.onLive(async (ctx) => {
      const publish = () => {
        extensions.set(serverExtensions(sandbox.value, servers.value.connected()));
        shown.set({ servers: servers.value.statuses(), problems: servers.value.problems(),
          signInAttempt: servers.value.signIns.getSnapshot() });
      };
      const stops = [servers.value.subscribe(publish), servers.value.signIns.subscribe(publish)];
      const configuration = mcpConfiguration(CONFIG);
      // At a start, only the log has these; a reload's reply carries them.
      for (const problem of configuration.problems) console.error('InfiniChat:', problem);
      // Each server connects as it is made; the summary matters to a reload only.
      void servers.value.apply(configuration).catch(report);
      publish();
      try {
        await untilAborted(ctx);
      } finally {
        for (const stop of stops) stop();
      }
    });
    return {
      servers: self.derive([shown], ([view]) => view.servers),
      problems: self.derive([shown], ([view]) => view.problems),
      signInAttempt: self.derive([shown], ([view]) => view.signInAttempt),
      signIn: async ({ server }) => servers.value.signIn(server),
      answer: async ({ promptId, value }) => done(servers.value.answer(promptId, value)),
      cancelSignIn: async () => done(servers.value.cancelSignIn()),
      signOut: async ({ server }) => done(servers.value.signOut(server)),
      reconnect: async ({ server }) => done(servers.value.reconnect(server)),
      mcp: async () => servers.value.apply(mcpConfiguration(CONFIG)),
    };
  });

  /** `/mcp` as clients hold it (all act as the owner): the tools object's servers and its sign-in under way. */
  host.serve(InfiniChatMcp, (_params, _principal, self) => {
    const tools = self.get(InfiniChatTools, {});
    return {
      variant: 'owner',
      members: {
        servers: tools.servers, problems: tools.problems, signInAttempt: tools.signInAttempt,
        signIn: tools.signIn, answer: tools.answer, cancelSignIn: tools.cancelSignIn, signOut: tools.signOut,
        reconnect: tools.reconnect,
      },
    };
  });
});
