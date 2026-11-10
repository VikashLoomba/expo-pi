import type { Root } from '@earendil-works/pi-mcp';
import type { McpServerStatus } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import type { CredentialBackend } from '@pi-agent/infinichat/pi/provider-credentials';
import { SignInAttempts } from '@pi-agent/infinichat/pi/sign-in';

import type { McpConfiguration, McpDisabledServer, McpServerConfig } from './mcp-config';
import type { McpLog } from './mcp-log';
import { mcpCredentials, signInMcpServer, type McpCredentials } from './mcp-oauth';
import { McpServer } from './mcp-server';
import type { ConnectedServer } from './mcp-tools';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const report = (error: unknown) => console.error('InfiniChat:', message(error));
const counted = (name: string, server: McpServer) =>
  `${name} (${server.tools.length} tool${server.tools.length === 1 ? '' : 's'})`;

/**
 * The machine's MCP servers, a native of the tools plugin's object (`tools-facet.ts`), which opens it once and closes
 * it with the host: the connections of `~/.infinichat/mcp.json` as last applied, those its configuration turns off and
 * what it skipped, and the sign-ins to the OAuth ones, one at a time, as the provider sign-ins run (`SignInAttempts`),
 * as `/mcp` shows and acts on them (`InfiniChatMcp`). A Chord native never changes while its object lives (chord
 * `docs/design.md` §13), and a reload restarts only the objects of plugins whose code changed (§21), so the
 * configuration is applied here, by `apply`: at the object's start and at each `/reload-plugins`. It holds this
 * machine's MCP credentials and log, which the connections borrow. Its listeners hear of every change of any server.
 */
export class McpServers {
  readonly signIns = new SignInAttempts<{ server: string }>((error) => message(error));
  private servers: readonly ConnectedServer[] = [];
  private disabled: readonly McpDisabledServer[] = [];
  private problemList: readonly string[] = [];
  private stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();

  /** `roots` are the folders each server is given, as the coding agent gives its session's; `version` the release. */
  constructor(private readonly backend: CredentialBackend, readonly log: McpLog,
    private readonly roots: readonly Root[], private readonly version: string) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** A server's credentials, in the one store every connection and sign-in shares. */
  credentials(name: string, serverUrl: string): McpCredentials {
    return mcpCredentials(this.backend, name, serverUrl);
  }

  /** The servers of the configuration last applied, with their connections. */
  connected(): readonly ConnectedServer[] {
    return this.servers;
  }

  /**
   * Applies the configuration as read now: connects the servers added, replaces those whose connection is made with
   * something else (`McpServerConfig.version`), retires those removed, and connects again each that is left but isn't
   * connected, such as one that was down. A retired connection finishes the requests it runs (`McpServer.retire`).
   * Says which connected, reconnected, closed, failed or stayed as they were, and what the configuration skipped.
   */
  async apply({ servers, disabled, problems }: McpConfiguration): Promise<string> {
    const previous = this.servers;
    const opened = new Set<string>();
    const next = servers.map((config): ConnectedServer => {
      const kept = previous.find((entry) => entry.config.name === config.name);
      if (kept !== undefined && kept.config.version === config.version) return { config, server: kept.server };
      opened.add(config.name);
      return { config, server: this.open(config) };
    });
    for (const { server } of previous) {
      if (!next.some((entry) => entry.server === server)) void server.retire()?.catch(report);
    }
    for (const stop of this.stops) stop();
    this.servers = next;
    this.disabled = disabled;
    this.problemList = problems;
    this.stops = next.map(({ server }) => server.subscribe(() => this.changed()));
    this.changed();
    const outcomes = await Promise.all(next.map(async ({ config: { name }, server }) => {
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
      } else if (opened.has(name) && previous.some((entry) => entry.config.name === name)) {
        reconnected.push(counted(name, server));
      } else if (opened.has(name) || !wasConnected) {
        connected.push(counted(name, server));
      } else {
        unchanged.push(name);
      }
    }
    const closed = previous.map((entry) => entry.config.name)
      .filter((name) => !next.some((entry) => entry.config.name === name));
    const done = Object.entries({ connected, reconnected, closed, failed, unchanged })
      .filter(([, names]) => names.length > 0).map(([what, names]) => `${what} ${names.join(', ')}`);
    return [`MCP: ${done.join('; ') || 'no servers'}.`, ...reasons, ...problems].join('\n');
  }

  /** A server's connection, which connects as it is made (`McpServer`). */
  private open({ name, connection }: McpServerConfig): McpServer {
    const oauth = 'url' in connection && connection.oauth !== undefined ? {
      serverUrl: connection.url, settings: connection.oauth, credentials: this.credentials(name, connection.url),
    } : undefined;
    return new McpServer(name, connection, oauth, this.log, this.roots, this.version);
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

  /** Ends a sign-in under way and retires every connection, as the host closes. */
  close(): void {
    this.signIns.cancel();
    for (const stop of this.stops) stop();
    this.stops = [];
    for (const { server } of this.servers) void server.retire()?.catch(report);
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
