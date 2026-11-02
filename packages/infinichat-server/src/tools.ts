import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { copyJson } from '@earendil-works/chord';
import type { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension, type CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import {
  McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type CallToolResult, type McpTransport, type Tool,
} from '@earendil-works/pi-mcp';
import {
  arr, bool, compile, map, num, obj, oneOf, opt, str, unknown, type Schema, type Static,
} from '@earendil-works/pi-schema';

/**
 * How a server's tools reach the model, as pi's coding agent exposes them (coding-agent `docs/mcp.md`, "Control tool
 * exposure"): `codemode`, the default, and `deferred` are pi-durable's deferred tools, which codemode scripts call and
 * `tool_search` loads but the model is not offered nor the `codemode` section lists (durable README "Who may call a
 * tool"); `direct` tools are offered; `hidden` ones are not registered.
 */
const ExposureSchema = oneOf(['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']);
type Exposure = Static<typeof ExposureSchema>;
const common = {
  type: opt(oneOf(['stdio', 'http', 'streamable-http'])),
  enabled: opt(bool()),
  description: opt(str()),
  /** Seconds per request, pi-mcp's `requestTimeoutMs`; progress notifications renew it. */
  timeout: opt(num({ exclusiveMinimum: 0 })),
  exposure: opt(ExposureSchema),
};
// Open, as the coding agent's configuration allows keys this server does not read.
const isStdioServer = compile(obj({
  ...common,
  command: str({ minLength: 1 }),
  args: opt(arr(str())),
  env: opt(map(str())),
  cwd: opt(str()),
}, { open: true })).check;
const isHttpServer = compile(obj({
  ...common,
  url: str({ minLength: 1 }),
  headers: opt(map(str())),
}, { open: true })).check;
const isConfigFile = compile(obj({ mcpServers: opt(map(unknown())) }, { open: true })).check;
/** What scripts get for a call, the coding agent's: the server's `CallToolResult` without `_meta`. */
const CallResultSchema = obj({
  content: arr(unknown()),
  structuredContent: opt(unknown()),
  isError: opt(bool()),
}, { open: true });

const NAME = /^[A-Za-z0-9_-]+$/;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** Provider tool names are at most 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME = 64;
/** pi-mcp's own request timeout, in seconds, as the coding agent's default `timeout`. */
const DEFAULT_TIMEOUT = 60;
/** The configuration as the user knows it, in messages. */
const FILE = '~/.infinichat/mcp.json';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const report = (error: unknown) => console.error('InfiniChat:', message(error));

/** What a server's connection is made with, resolved; a change of any of it reconnects the server. */
type Connection = { readonly timeout?: number } & ({
  readonly url: string; readonly headers?: Readonly<Record<string, string>>;
} | {
  readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
});

/** An enabled server of the configuration. */
export interface McpServerConfig {
  readonly name: string;
  readonly exposure: Exclude<Exposure, 'codemode-deferred'>;
  readonly description?: string;
  readonly connection: Connection;
  /** Its resource's version, a hash of `connection`: Chord reopens a resource whose version changed. */
  readonly version: number;
}

/** The enabled servers, and why the others are left out. */
export interface McpConfiguration {
  readonly servers: readonly McpServerConfig[];
  readonly problems: readonly string[];
}

/**
 * `${NAME}` from this process's environment, as the coding agent expands `env` and `headers` values. A name the
 * environment lacks goes into `missing`, which skips the server: an empty value would fail it in a less clear way.
 */
function expand(values: Readonly<Record<string, string>> | undefined, missing: Set<string>) {
  return values === undefined ? undefined : Object.fromEntries(Object.entries(values).map(([key, value]) =>
    [key, value.replace(VARIABLE, (_match, name: string) => {
      if (process.env[name] === undefined) missing.add(name);
      return process.env[name] ?? '';
    })]));
}

/** A leading `~/` names the home folder, as the coding agent reads `command`, `args` and `cwd`. */
const home = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

/** A configured server's entry, resolved, or why it is skipped: the coding agent's rules, less what this lacks. */
function parseServer(name: string, entry: unknown): McpServerConfig | string | undefined {
  const skipped = (reason: string) => `MCP server ${name} skipped: ${reason}`;
  if (!NAME.test(name)) return skipped('a name may contain only letters, digits, _ and -.');
  if (typeof entry === 'object' && entry !== null && ('oauth' in entry || 'toolExposure' in entry)) {
    return skipped('oauth and toolExposure are not supported on InfiniChat’s server.');
  }
  const stdio = isStdioServer(entry) && entry.type !== 'http' && entry.type !== 'streamable-http'
    ? entry : undefined;
  const http = isHttpServer(entry) && entry.type !== 'stdio' ? entry : undefined;
  const missing = new Set<string>();
  const connection: Connection | undefined = stdio !== undefined
    ? { command: home(stdio.command), args: stdio.args?.map(home), env: expand(stdio.env, missing),
      cwd: stdio.cwd === undefined ? undefined : resolve(homedir(), home(stdio.cwd)), timeout: stdio.timeout }
    : http && { url: http.url, headers: expand(http.headers, missing), timeout: http.timeout };
  const config = stdio ?? http;
  if (config === undefined || connection === undefined) {
    return skipped('it needs a command (stdio) or a url (streamable HTTP), not SSE.');
  }
  if (config.enabled === false) return undefined;
  if (missing.size > 0) return skipped(`the server’s environment has no ${[...missing].join(', ')}.`);
  const exposure = config.exposure ?? 'codemode';
  // 48 bits of the hash, an integer Chord takes as a version.
  const version = Number.parseInt(createHash('sha256').update(JSON.stringify(connection)).digest('hex').slice(0, 12),
    16);
  return { name, exposure: exposure === 'codemode-deferred' ? 'codemode' : exposure,
    ...(config.description === undefined ? {} : { description: config.description }), connection, version };
}

/**
 * `file`, read synchronously, as a Chord factory declares (chord `docs/guide.md` "Serving objects"). A file that is
 * missing configures no server; one that can't be read or parsed configures none either, and says why, as does each
 * entry that is left out.
 */
export function mcpConfiguration(file: string): McpConfiguration {
  const none = (problem: string) => ({ servers: [], problems: [`${problem} No MCP server is connected.`] });
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { servers: [], problems: [] };
    return none(`${FILE} could not be read: ${message(error)}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return none(`${FILE} is not valid JSON: ${message(error)}.`);
  }
  if (!isConfigFile(parsed)) return none(`${FILE} needs an mcpServers object.`);
  const servers: McpServerConfig[] = [];
  const problems: string[] = [];
  // Tool and namespace names write `-` as `_`, so two names that differ only there would collide.
  const keys = new Set<string>();
  for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
    const server = parseServer(name, entry);
    if (typeof server === 'string') problems.push(server);
    if (typeof server !== 'object') continue;
    const key = name.replace(/-/g, '_');
    if (keys.has(key)) {
      problems.push(`MCP server ${name} skipped: another server’s name differs from it only in - and _.`);
      continue;
    }
    keys.add(key);
    servers.push(server);
  }
  return { servers, problems };
}

/**
 * `mcp__<server>__<tool>` as the coding agent names it (`src/extensions/mcp/tools.ts:84-93`): everything but
 * `[A-Za-z0-9_]` becomes `_`, so the name is also the identifier scripts call it by, with a hash suffix when it is too
 * long or another tool already took it.
 */
function toolName(server: string, tool: string, taken: ReadonlySet<string>): string {
  const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_');
  if (name.length <= MAX_TOOL_NAME && !taken.has(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${name.slice(0, MAX_TOOL_NAME - hash.length - 1)}_${hash}`;
}

/**
 * One configured server's connection, the resource the tools plugin's object declares for it (`tools-facet.ts`). It
 * connects and lists the server's tools in the background, so a server that fails leaves the plugin's activation and
 * reloads alone, and a dropped connection reconnects at the next call.
 */
export class McpServer {
  tools: readonly Tool[] = [];
  instructions?: string;
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private closing?: Promise<void>;
  private closeClient?: () => Promise<void>;
  private readonly shutdown = new AbortController();
  private readonly calls = new Set<Promise<CallToolResult>>();
  private readonly listeners = new Set<() => void>();
  private retired = false;
  private closed = false;

  constructor(readonly name: string, private readonly connection: Connection) {
    void this.connect().catch((error: unknown) => report(`MCP server ${name} failed to connect: ${message(error)}`));
  }

  get connected(): boolean {
    return this.client?.connectionState === 'connected';
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

  /** Tells `listener` when the server's tools change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
    const pending = this.connect().then((client) => client.callTool(tool, args, { signal }));
    this.calls.add(pending);
    const settled = () => {
      this.calls.delete(pending);
      if (this.retired && this.calls.size === 0) void this.close().catch(report);
    };
    void pending.then(settled, settled);
    return pending;
  }

  /**
   * The resource's close, when a reload replaces or removes the server or the host closes: calls already running
   * finish on this connection, as a Durable phase keeps the tools it started with (durable `docs/spec.md` §7.5), and
   * it closes once they settle. It doesn't wait for them, so the host goes on to close the Harness, which aborts them.
   */
  retire(): Promise<void> | undefined {
    this.retired = true;
    return this.calls.size === 0 ? this.close() : undefined;
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

  private transport(): McpTransport {
    const { connection } = this;
    if ('url' in connection) return new StreamableHttpTransport({ url: connection.url, headers: connection.headers });
    return new StdioTransport({ command: connection.command, args: connection.args, env: connection.env,
      cwd: connection.cwd });
  }

  private async open(): Promise<McpClient> {
    const client = new McpClient({ name: 'infinichat', version: INFINICHAT_SERVER_VERSION,
      requestTimeoutMs: (this.connection.timeout ?? DEFAULT_TIMEOUT) * 1000 });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= client.close();
    this.closeClient = close;
    const abort = () => { void close().catch(report); };
    this.shutdown.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(this.transport());
      client.onClose(() => {
        if (this.client === client) this.client = undefined;
      });
      client.onNotification('notifications/tools/list_changed', () => {
        void this.list(client).catch(report);
      });
      const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
      if (this.closed || client.connectionState !== 'connected') {
        throw new Error(`MCP server ${this.name} closed during discovery.`);
      }
      this.client = client;
      this.tools = tools;
      this.instructions = client.instructions;
      this.changed();
      return client;
    } catch (error) {
      await close();
      throw error;
    } finally {
      this.shutdown.signal.removeEventListener('abort', abort);
    }
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

/**
 * `tool`'s input schema as providers take it: an object schema, which some reject without `properties` (pi-mcp
 * README). Typed as the objects it accepts, as pi-schema's builders type the JSON Schema they return: the Harness
 * validates a call's arguments against it before `execute`.
 */
function mcpParameters(tool: Tool): Schema<Record<string, unknown>> {
  return { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} };
}

/** A pi-durable tool calling `tool` of `server`; its result reaches the model as text and images, and scripts whole. */
function mcpTool(server: McpServer, direct: boolean, tool: Tool, name: string): ToolRegistration {
  return defineTool({
    name,
    description: tool.description ?? tool.title ?? `${tool.name} of the MCP server ${server.name}`,
    parameters: mcpParameters(tool),
    structuredOutputSchema: CallResultSchema,
    ...(direct ? {} : { deferred: true as const }),
    async execute(args, _api, context) {
      const result = await server.call(tool.name, args, context.abortSignal);
      const { content, structuredContent, isError } = result;
      return {
        output: toLlmContent(result),
        structuredOutput: copyJson({ content, ...(structuredContent === undefined ? {} : { structuredContent }),
          ...(isError ? { isError } : {}) }),
        // MCP reports a tool's own failure in its result rather than as a protocol error.
        ...(isError ? { isError: true } : {}),
      };
    },
  });
}

/**
 * Code mode over `sandbox`, with a namespace per server, and the servers' tools as they last listed them: fresh
 * extension objects on every call, never one a running phase already holds.
 */
export function serverExtensions(sandbox: CodemodeSandbox,
  servers: readonly { config: McpServerConfig; server: McpServer }[]): readonly Extension[] {
  const taken = new Set<string>();
  const tools: ToolRegistration[] = [];
  for (const { config, server } of servers) {
    if (config.exposure === 'hidden') continue;
    for (const tool of server.tools) {
      const name = toolName(config.name, tool.name, taken);
      taken.add(name);
      tools.push(mcpTool(server, config.exposure === 'direct', tool, name));
    }
  }
  const namespaces: CodemodeNamespace[] = servers.map(({ config, server }) => {
    const description = config.description ?? server.instructions?.split('\n')[0];
    return {
      name: `mcp__${config.name}`,
      prefix: `mcp__${config.name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
      ...(description ? { description } : {}),
      ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
    };
  });
  const searched = servers.some(({ config, server }) => config.exposure === 'deferred' && server.tools.length > 0);
  return [
    createCodemodeExtension({ sandbox, namespaces }),
    ...(tools.length === 0 ? [] : [defineExtension({ name: 'mcp', tools })]),
    ...(searched ? [createToolSearchExtension()] : []),
  ];
}
