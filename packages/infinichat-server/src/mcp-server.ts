import { setTimeout as sleep } from 'node:timers/promises';

import {
  JSON_RPC_ERROR_CODES, McpAuthRequiredError, McpClient, McpError, McpHttpError, McpSessionExpiredError, StdioTransport,
  StreamableHttpTransport, type CallToolResult, type ListResourcesResult, type ListResourceTemplatesResult,
  type McpRequestOptions, type McpTransport, type ProgressNotification, type ReadResourceResult, type Resource,
  type ResourceTemplate, type Root, type Tool,
} from '@earendil-works/pi-mcp';
import { McpOAuthAuthorizationRequiredError, type OAuthChallenge } from '@earendil-works/pi-mcp/oauth';

import type { McpConnection, McpOAuthSettings } from './mcp-config';
import type { McpLog } from './mcp-log';
import { connectionAuth, type McpCredentials } from './mcp-oauth';

/** pi-mcp's own request timeout, in seconds, as the coding agent's default `timeout`. */
const DEFAULT_TIMEOUT = 60;
/** The coding agent's tail of a failed stdio server's stderr, and its retries of an HTTP connect (`runtime.ts:49-51`). */
const STDERR_TAIL_CHARS = 2_000;
const CONNECT_RETRY_DELAYS_MS = [250, 1_000];

export type McpServerState = 'connecting' | 'connected' | 'needs-sign-in' | 'failed' | 'disconnected';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const report = (error: unknown) => console.error('InfiniChat:', message(error));

/** Network failures and overloaded or restarting servers, which are worth another attempt (`runtime.ts:69-75`). */
function isTransientError(error: unknown): boolean {
  if (error instanceof McpHttpError) {
    return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status !== 501);
  }
  return error instanceof TypeError;
}

/** Servers that do not implement `resources/templates/list` have no templates. */
async function withoutTemplates<T>(list: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await list();
  } catch (error) {
    if (error instanceof McpError && error.code === JSON_RPC_ERROR_CODES.methodNotFound) return empty;
    throw error;
  }
}

/** What an OAuth server signs in with: its URL, the client settings, and this machine's credentials for it. */
export interface McpOAuth {
  readonly serverUrl: string;
  readonly settings: McpOAuthSettings;
  readonly credentials: McpCredentials;
}

/**
 * One configured server's connection, the resource the tools plugin's object declares for it (`tools-facet.ts`), as
 * the coding agent's `McpServerConnection` (`src/extensions/mcp/runtime.ts` at v1.5.0). It connects and lists the
 * server's tools in the background, so a server that fails leaves the plugin's activation and reloads alone; a dropped
 * connection reconnects at the next request, and one whose session the server forgot (a restart, a deploy) starts a
 * new session once. An OAuth server that still rejects a request after a refresh needs the user to sign in again
 * (`needs-sign-in`), which `/mcp` does. Its state, tools and errors change in place, and `subscribe` hears of each.
 */
export class McpServer {
  state: McpServerState = 'connecting';
  error?: string;
  tools: readonly Tool[] = [];
  /** Whether the server offers resources, which the resource tools list and read on demand. */
  hasResources = false;
  instructions?: string;
  /** For an OAuth server, whether this machine holds its credentials. */
  signedIn?: boolean;
  /** The server's last OAuth challenge, whose resource metadata URL and scope a sign-in uses. */
  challenge?: OAuthChallenge;
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private closing?: Promise<void>;
  private closeClient?: () => Promise<void>;
  private stderrTail?: string;
  private readonly shutdown = new AbortController();
  private readonly calls = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private retired = false;
  private closed = false;

  constructor(readonly name: string, private readonly connection: McpConnection, readonly oauth: McpOAuth | undefined,
    private readonly log: McpLog, private readonly roots: readonly Root[]) {
    void this.readSignIn();
    // Its failure says what happened (`connectFailed`), and `/mcp` shows it.
    void this.connect().catch(report);
  }

  get transportKind(): 'stdio' | 'http' {
    return 'url' in this.connection ? 'http' : 'stdio';
  }

  /** Connects unless connected, joining an attempt under way. */
  connect(): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.name} is closed.`));
    if (this.client?.connectionState === 'connected') return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  /** Connects again with the credentials stored now, as after a sign-in. */
  async reconnect(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (this.client) await this.drop(this.client);
    await this.readSignIn();
    await this.connect();
  }

  /** Disconnects after the stored credentials were removed. */
  async signedOut(): Promise<void> {
    await this.connecting?.catch(() => {});
    if (this.client) await this.drop(this.client);
    this.challenge = undefined;
    await this.readSignIn();
    if (!this.closed) this.mark('needs-sign-in');
  }

  /** Tells `listener` when the server's state, tools or errors change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined,
    onProgress: (progress: ProgressNotification) => void): Promise<CallToolResult> {
    return this.request((client, options) => client.callTool(tool, args, { ...options, signal, onProgress }));
  }

  resourcesPage(cursor: string | undefined, signal: AbortSignal | undefined): Promise<ListResourcesResult> {
    return this.request((client, options) => client.listResourcesPage(cursor, { ...options, signal }), true);
  }

  resourceTemplatesPage(cursor: string | undefined, signal: AbortSignal | undefined):
    Promise<ListResourceTemplatesResult> {
    return this.request((client, options) => withoutTemplates(
      () => client.listResourceTemplatesPage(cursor, { ...options, signal }), { resourceTemplates: [] }), true);
  }

  allResources(signal: AbortSignal | undefined): Promise<Resource[]> {
    return this.request((client, options) => client.listResources({ ...options, signal }), true);
  }

  allResourceTemplates(signal: AbortSignal | undefined): Promise<ResourceTemplate[]> {
    return this.request((client, options) => withoutTemplates(
      () => client.listResourceTemplates({ ...options, signal }), []), true);
  }

  readResource(uri: string, signal: AbortSignal | undefined): Promise<ReadResourceResult> {
    return this.request((client, options) => client.readResource(uri, { ...options, signal }), true);
  }

  /**
   * The resource's close, when a reload replaces or removes the server or the host closes: requests already running
   * finish on this connection, as a Durable phase keeps the tools it started with (durable `docs/spec.md` §7.5), and
   * it closes once they settle. It doesn't wait for them, so the host goes on to close the Harness, which aborts them.
   */
  retire(): Promise<void> | undefined {
    this.retired = true;
    return this.calls.size === 0 ? this.close() : undefined;
  }

  /**
   * A request, reconnecting when needed (`runtime.ts:276-301`): `readOnly` ones are retried once after a transient
   * HTTP error, and tool calls are not, since they may have run; a forgotten session is replaced once, since the
   * server did not run the request. The old client is left to its other requests, which meet the same 404.
   */
  private request<T>(run: (client: McpClient, options: McpRequestOptions) => Promise<T>, readOnly = false):
    Promise<T> {
    const pending = (async () => {
      for (let attempt = 1; ; attempt++) {
        const client = await this.connect();
        try {
          return await run(client, { timeoutMs: (this.connection.timeout ?? DEFAULT_TIMEOUT) * 1000 });
        } catch (error) {
          if (readOnly && attempt === 1 && isTransientError(error)) {
            await sleep(CONNECT_RETRY_DELAYS_MS[0]);
            continue;
          }
          if (error instanceof McpSessionExpiredError && attempt === 1) {
            if (this.client === client) this.client = undefined;
            continue;
          }
          if (!this.needsSignIn(error)) throw error;
          await this.drop(client);
          this.mark('needs-sign-in');
          throw new Error(this.signInRequired());
        }
      }
    })();
    this.calls.add(pending);
    const settled = () => {
      this.calls.delete(pending);
      if (this.retired && this.calls.size === 0) void this.close().catch(report);
    };
    void pending.then(settled, settled);
    return pending;
  }

  private signInRequired(): string {
    return `MCP server ${this.name} requires sign-in. Type /mcp to sign in.`;
  }

  /** OAuth servers that still reject the request after a refresh need the user to sign in again. */
  private needsSignIn(error: unknown): boolean {
    return error instanceof McpOAuthAuthorizationRequiredError
      || (this.oauth !== undefined && error instanceof McpAuthRequiredError);
  }

  private mark(state: McpServerState, error?: string): void {
    this.state = state;
    this.error = error;
    this.changed();
  }

  private async readSignIn(): Promise<void> {
    if (this.oauth === undefined) return;
    this.signedIn = (await this.oauth.credentials.load().catch(() => undefined))?.tokens !== undefined;
    this.changed();
  }

  private close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    this.client = undefined;
    await Promise.all([this.closeClient?.(), this.connecting?.catch(() => {})]);
  }

  private async drop(client: McpClient): Promise<void> {
    if (this.client === client) this.client = undefined;
    await client.close().catch(() => {});
  }

  private transport(): McpTransport {
    const { connection, oauth } = this;
    if ('url' in connection) {
      return new StreamableHttpTransport({ url: connection.url, headers: connection.headers,
        authProvider: oauth && connectionAuth(oauth.serverUrl, oauth.credentials, oauth.settings, (challenge) => {
          this.challenge = challenge;
        }) });
    }
    return new StdioTransport({ command: connection.command, args: connection.args, env: connection.env,
      cwd: connection.cwd, stderr: 'pipe' });
  }

  /** Connects, retrying an HTTP server's transient failures as the coding agent does (`runtime.ts:341-357`). */
  private async open(): Promise<McpClient> {
    this.mark('connecting');
    const retries = 'url' in this.connection ? CONNECT_RETRY_DELAYS_MS : [];
    for (let attempt = 0; ; attempt++) {
      this.stderrTail = undefined;
      try {
        return await this.connectOnce();
      } catch (error) {
        const delay = retries[attempt];
        if (this.closed || delay === undefined || !isTransientError(error)) throw this.connectFailed(error);
        await sleep(delay, undefined, { signal: this.shutdown.signal }).catch(() => {});
        if (this.closed) throw this.connectFailed(error);
      }
    }
  }

  private async connectOnce(): Promise<McpClient> {
    const client = new McpClient({ name: 'infinichat', version: INFINICHAT_SERVER_VERSION,
      requestTimeoutMs: (this.connection.timeout ?? DEFAULT_TIMEOUT) * 1000, roots: this.roots });
    client.onNotification('notifications/message', (params) => this.log.write(this.name, params));
    let closing: Promise<void> | undefined;
    const close = () => closing ??= client.close().catch(() => {});
    this.closeClient = close;
    const abort = () => { void close(); };
    this.shutdown.signal.addEventListener('abort', abort, { once: true });
    let transport: McpTransport | undefined;
    try {
      transport = this.transport();
      await client.connect(transport);
      client.onNotification('notifications/tools/list_changed', () => {
        void this.list(client).catch(report);
      });
      const stdio = transport instanceof StdioTransport ? transport : undefined;
      client.onClose(() => this.dropped(client, stdio));
      // Servers without the tools capability (prompts or resources only) do not answer tools/list.
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      if (this.closed || client.connectionState !== 'connected') {
        throw new Error(`MCP server ${this.name} closed during discovery.`);
      }
      this.client = client;
      this.tools = tools;
      this.hasResources = client.serverCapabilities?.resources !== undefined;
      this.instructions = client.instructions?.trim() || undefined;
      this.mark('connected');
      void this.readSignIn();
      return client;
    } catch (error) {
      await close();
      if (transport instanceof StdioTransport) {
        this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
      }
      throw error;
    } finally {
      this.shutdown.signal.removeEventListener('abort', abort);
    }
  }

  private connectFailed(error: unknown): Error {
    if (this.needsSignIn(error) && !this.closed) {
      this.mark('needs-sign-in');
      return new Error(this.signInRequired());
    }
    const failure = this.stderrTail ? `${message(error)}\n${this.stderrTail}` : message(error);
    this.mark('failed', failure);
    return new Error(`MCP server ${this.name} failed to connect: ${failure}`);
  }

  /** The transport dropped. The next request reconnects; until then the status says why. */
  private dropped(client: McpClient, stdio: StdioTransport | undefined): void {
    if (this.client !== client || this.closed) return;
    this.client = undefined;
    const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
    this.mark('disconnected', stderr ? `Connection closed\n${stderr}` : 'Connection closed');
  }

  private async list(client: McpClient): Promise<void> {
    const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
    if (this.client !== client || this.closed) return;
    this.tools = tools;
    this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
