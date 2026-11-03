import { local, opaque } from '@earendil-works/chord';
import { obj } from '@earendil-works/pi-schema';
import { SignInAttempts } from '@pi-agent/infinichat/node/sign-in';
import type { McpServerStatus } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';

import type { McpDisabledServer } from './mcp-config';
import type { McpLog } from './mcp-log';
import { mcpCredentials, signInMcpServer, type McpCredentials } from './mcp-oauth';
import type { ConnectedServer } from './mcp-tools';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const report = (error: unknown) => console.error('InfiniChat:', message(error));

/**
 * The machine's MCP servers as `/mcp` shows and acts on them (`InfiniChatMcp`): the servers the tools plugin's object
 * connected at its last run, those its configuration turns off and what it skipped, and the sign-ins to the OAuth ones,
 * one at a time, as the provider sign-ins run (`SignInAttempts`). It holds what outlives a run: this machine's MCP
 * credentials and log, which the connections borrow. Its listeners hear of every change of any server.
 */
export class McpServers {
  readonly signIns = new SignInAttempts<{ server: string }>((error) => message(error));
  private servers: readonly ConnectedServer[] = [];
  private disabled: readonly McpDisabledServer[] = [];
  private problemList: readonly string[] = [];
  private stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly backend: CredentialBackend, readonly log: McpLog) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** A server's credentials, in the one store every connection and sign-in shares. */
  credentials(name: string, serverUrl: string): McpCredentials {
    return mcpCredentials(this.backend, name, serverUrl);
  }

  /** What the tools plugin's object declared at its run, once it is live. */
  update(servers: readonly ConnectedServer[], disabled: readonly McpDisabledServer[], problems: readonly string[]) {
    for (const stop of this.stops) stop();
    this.servers = servers;
    this.disabled = disabled;
    this.problemList = problems;
    this.stops = servers.map(({ server }) => server.subscribe(() => this.changed()));
    this.changed();
  }

  statuses(): McpServerStatus[] {
    const connected = this.servers.map(({ config, server }): McpServerStatus => ({
      name: config.name, transport: server.transportKind, state: server.state, exposure: config.exposure,
      tools: server.tools.length, resources: server.hasResources,
      ...(config.description === undefined ? {} : { description: config.description }),
      ...(server.error === undefined ? {} : { error: server.error }),
      ...(server.oauth === undefined ? {} : { signIn: { signedIn: server.signedIn === true } }),
    }));
    const disabled = this.disabled.map(({ name, transport, exposure, description }): McpServerStatus => ({
      name, transport, state: 'disabled', exposure, tools: 0, resources: false,
      ...(description === undefined ? {} : { description }),
    }));
    return [...connected, ...disabled].sort((a, b) => a.name.localeCompare(b.name));
  }

  problems(): string[] {
    return [...this.problemList];
  }

  /**
   * Starts a sign-in to `name`, ending one under way, and returns its number. The server connects again once it signs
   * in, with the challenge its last 401 carried, as the coding agent's `/mcp` does.
   */
  signIn(name: string): number {
    const server = this.find(name);
    const oauth = server.oauth;
    if (oauth === undefined) throw new Error(`MCP server ${name} doesn’t sign in with OAuth.`);
    return this.signIns.start({ server: name }, async (interaction) => {
      await signInMcpServer({ serverUrl: oauth.serverUrl, store: oauth.credentials, settings: oauth.settings,
        challenge: server.challenge, interaction });
      void server.reconnect().catch(report);
    });
  }

  answer(promptId: number, value: string): void {
    this.signIns.answer(promptId, value);
  }

  cancelSignIn(): void {
    this.signIns.cancel();
  }

  /** Deletes the server's stored credentials and disconnects it, as the coding agent's sign-out does. */
  async signOut(name: string): Promise<void> {
    const server = this.find(name);
    if (server.oauth === undefined) throw new Error(`MCP server ${name} doesn’t sign in with OAuth.`);
    if (this.signIns.getSnapshot()?.server === name) this.signIns.cancel();
    await server.oauth.credentials.remove();
    await server.signedOut();
  }

  reconnect(name: string): Promise<void> {
    return this.find(name).reconnect();
  }

  close(): void {
    this.signIns.cancel();
    for (const stop of this.stops) stop();
    this.stops = [];
  }

  private find(name: string) {
    const found = this.servers.find(({ config }) => config.name === name)?.server;
    if (found) return found;
    if (this.disabled.some((server) => server.name === name)) {
      throw new Error(`MCP server ${name} is turned off in ~/.infinichat/mcp.json.`);
    }
    throw new Error(`There is no MCP server ${name} in ~/.infinichat/mcp.json.`);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

/**
 * The tools plugin's registry of servers, one object of lifetime `"host"` (`tools-facet.ts`): the tools plugin's
 * object, which connects the servers, and `/mcp`'s object, which clients hold, both borrow it.
 */
export const McpRegistry = local('infinichat.mcp-registry', {
  version: 1,
  input: obj({}, { open: true }),
  members: { servers: opaque<McpServers>('infinichat.mcp-servers@1') },
});
