import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { copyJson } from '@earendil-works/chord';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { Type, type Static } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension, type CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { createToolSearchExtension } from '@earendil-works/pi-durable/tool-search';
import {
  McpClient, StdioTransport, StreamableHttpTransport, toLlmContent, type CallToolResult, type McpTransport, type Tool,
} from '@earendil-works/pi-mcp';
import { Check } from 'typebox/value';

import type { ExtensionSource } from './registry';

/**
 * How a server's tools reach the model, as pi's coding agent exposes them (coding-agent `docs/mcp.md`, "Control tool
 * exposure"): `codemode`, the default, and `deferred` are pi-durable's deferred tools, which codemode scripts call and
 * `tool_search` loads but the model is not offered nor the `codemode` section lists (durable README "Who may call a
 * tool"); `direct` tools are offered; `hidden` ones are not registered.
 */
const ExposureSchema = Type.Union([Type.Literal('codemode'), Type.Literal('codemode-deferred'),
  Type.Literal('deferred'), Type.Literal('direct'), Type.Literal('hidden')]);
type Exposure = Static<typeof ExposureSchema>;
const common = {
  type: Type.Optional(Type.Union([Type.Literal('stdio'), Type.Literal('http'), Type.Literal('streamable-http')])),
  enabled: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
  /** Seconds per request, pi-mcp's `requestTimeoutMs`; progress notifications renew it. */
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  exposure: Type.Optional(ExposureSchema),
};
const StdioServerSchema = Type.Object({
  ...common,
  command: Type.String({ minLength: 1 }),
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  cwd: Type.Optional(Type.String()),
});
const HttpServerSchema = Type.Object({
  ...common,
  url: Type.String({ minLength: 1 }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
});
type ServerConfig = Static<typeof StdioServerSchema> | Static<typeof HttpServerSchema>;
const ConfigFileSchema = Type.Object({ mcpServers: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
/** What scripts get for a call, the coding agent's: the server's `CallToolResult` without `_meta`. */
const CallResultSchema = Type.Object({
  content: Type.Array(Type.Unknown()),
  structuredContent: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()),
});

const NAME = /^[A-Za-z0-9_-]+$/;
/** Provider tool names are at most 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME = 64;
/** pi-mcp's own request timeout, in seconds, as the coding agent's default `timeout`. */
const DEFAULT_TIMEOUT = 60;

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

/** `${NAME}` from this process's environment, as the coding agent expands `env` and `headers` values. */
const expand = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) =>
  process.env[name] ?? '');
const expandAll = (values: Readonly<Record<string, string>> | undefined) => values === undefined ? undefined
  : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value)]));
/** A leading `~/` names the home folder, as the coding agent reads `command`, `args` and `cwd`. */
const home = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

/** A configured server's entry, or why it is skipped: the coding agent's rules, less what this server lacks. */
function parseServer(name: string, entry: unknown): ServerConfig | string {
  if (!NAME.test(name)) return `MCP server name ${name} may contain only letters, digits, _ and -.`;
  if (typeof entry === 'object' && entry !== null && ('oauth' in entry || 'toolExposure' in entry)) {
    return `MCP server ${name}: oauth and toolExposure are not supported on InfiniChat's server.`;
  }
  if (Check(StdioServerSchema, entry) && entry.type !== 'http' && entry.type !== 'streamable-http') return entry;
  if (Check(HttpServerSchema, entry) && entry.type !== 'stdio') return entry;
  return `MCP server ${name} needs a command (stdio) or a url (streamable HTTP); SSE is not supported.`;
}

/** One connection generation. A reload retires it without interrupting requests that have already borrowed it. */
class McpServer {
  tools: readonly Tool[] = [];
  instructions?: string;
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private closing?: Promise<void>;
  private closeClient?: () => Promise<void>;
  private readonly shutdown = new AbortController();
  private readonly calls = new Set<Promise<CallToolResult>>();
  private retired = false;
  private closed = false;

  constructor(readonly name: string, readonly config: ServerConfig, private readonly owner: ServerToolsState) {
    owner.connections.add(this);
  }

  get exposure(): Exposure {
    const exposure = this.config.exposure ?? 'codemode';
    return exposure === 'codemode-deferred' ? 'codemode' : exposure;
  }

  /** A dropped connection reconnects on the next call, using this generation's captured configuration. */
  connect(): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.name} is closed.`));
    if (this.client?.connectionState === 'connected') return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
    const pending = this.connect().then((client) => client.callTool(tool, args, { signal }));
    this.calls.add(pending);
    const settled = () => {
      this.calls.delete(pending);
      if (this.retired && this.calls.size === 0) void this.close().catch(this.owner.report);
    };
    void pending.then(settled, settled);
    return pending;
  }

  retire(): void {
    this.retired = true;
    if (this.calls.size === 0) void this.close().catch(this.owner.report);
  }

  close(): Promise<void> {
    this.closing ??= this.finish();
    return this.closing;
  }

  private async finish(): Promise<void> {
    this.closed = true;
    this.shutdown.abort();
    this.client = undefined;
    try {
      await Promise.all([this.closeClient?.(), this.connecting?.catch(() => {})]);
    } finally {
      this.owner.connections.delete(this);
    }
  }

  private transport(): McpTransport {
    const { config } = this;
    if ('url' in config) return new StreamableHttpTransport({ url: config.url, headers: config.headers });
    return new StdioTransport({ command: config.command, args: config.args, env: config.env, cwd: config.cwd });
  }

  private async open(): Promise<McpClient> {
    const client = new McpClient({ name: 'infinichat', version: INFINICHAT_SERVER_VERSION,
      requestTimeoutMs: (this.config.timeout ?? DEFAULT_TIMEOUT) * 1000 });
    let closing: Promise<void> | undefined;
    const close = () => closing ??= client.close();
    this.closeClient = close;
    const abort = () => { void close().catch(this.owner.report); };
    this.shutdown.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.connect(this.transport());
      client.onClose(() => {
        if (this.client === client) this.client = undefined;
      });
      client.onNotification('notifications/tools/list_changed', () => {
        void this.list(client).catch(this.owner.report);
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
    if (this.client !== client || this.closed || this.retired) return;
    this.tools = tools;
    this.changed();
  }

  private changed(): void {
    if (!this.closed && !this.retired && this.owner.servers.includes(this)) notify(this.owner);
  }
}

/** A pi-durable tool calling `tool` of `server`; its result reaches the model as text and images, and scripts whole. */
function mcpTool(server: McpServer, tool: Tool, name: string): ToolRegistration {
  return defineTool({
    name,
    description: tool.description ?? tool.title ?? `${tool.name} of the MCP server ${server.name}`,
    // Providers require an object schema, and some reject one without `properties` (pi-mcp README).
    parameters: Type.Unsafe<Record<string, unknown>>({ ...tool.inputSchema, type: 'object',
      properties: tool.inputSchema.properties ?? {} }),
    structuredOutputSchema: CallResultSchema,
    ...(server.exposure === 'direct' ? {} : { deferred: true as const }),
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

/** Retained native resources and data only. The facet rebuilds the source and its implementation on every reload. */
export interface ServerToolsState {
  readonly sandbox: CodemodeSandbox;
  readonly connections: Set<McpServer>;
  readonly listeners: Set<() => void>;
  readonly report: (error: unknown) => void;
  servers: McpServer[];
}

const notify = (state: ServerToolsState) => {
  for (const listener of [...state.listeners]) listener();
};

/** Validate the whole file before changing anything. Only ENOENT means an intentionally absent configuration. */
async function configuration(folder: string): Promise<readonly { name: string; config: ServerConfig }[]> {
  const text = await readFile(join(folder, 'mcp.json'), 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('MCP configuration is not valid JSON.');
  }
  if (!Check(ConfigFileSchema, parsed)) throw new Error('MCP configuration needs an mcpServers object.');
  const seen = new Set<string>();
  const result: { name: string; config: ServerConfig }[] = [];
  for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
    const config = parseServer(name, entry);
    if (typeof config === 'string') throw new Error(config);
    const key = name.replace(/-/g, '_');
    if (seen.has(key)) throw new Error(`MCP server ${name} repeats another server's name.`);
    seen.add(key);
    if (config.enabled === false) continue;
    // Resolve options once: a phase using an older configuration must never borrow new credentials or endpoints.
    result.push({ name, config: 'url' in config
      ? { ...config, headers: expandAll(config.headers) }
      : { ...config, command: home(config.command), args: config.args?.map(home), env: expandAll(config.env),
        cwd: config.cwd === undefined ? undefined : resolve(homedir(), home(config.cwd)) } });
  }
  return result;
}

/** Startup stays responsive while MCP discovery runs; the registered source publishes completed discoveries. */
export async function openServerTools(folder: string, report: (error: unknown) => void): Promise<ServerToolsState> {
  const state: ServerToolsState = {
    sandbox: new CodemodeSandbox(), connections: new Set(), listeners: new Set(), report, servers: [],
  };
  try {
    state.servers = (await configuration(folder)).map(({ name, config }) => new McpServer(name, config, state));
    for (const server of state.servers) void server.connect().catch(report);
  } catch (error) {
    report(error);
  }
  return state;
}

/** The host calls this after the conversation has closed. It includes clients still connecting or draining. */
export async function closeServerTools(state: ServerToolsState): Promise<void> {
  try {
    await Promise.all([...state.connections].map((server) => server.close().catch(state.report)));
  } finally {
    await state.sandbox.close();
    state.listeners.clear();
  }
}

/**
 * A reload reconnects configured MCP sessions, as a changed command can still name the same executable. Prepare
 * discovery before publication; a failed configuration or connection keeps the previously working contribution.
 * Calls already executing drain on their old connection. The code-mode sandbox and Harness are never restarted.
 */
async function reloadServerTools(state: ServerToolsState, folder: string,
  validate: (extensions: readonly Extension[]) => void): Promise<string> {
  const next = (await configuration(folder)).map(({ name, config }) => new McpServer(name, config, state));
  try {
    await Promise.all(next.map(async (server) => {
      try {
        await server.connect();
      } catch (error) {
        throw new Error(`MCP server ${server.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    validate(serverExtensions({ ...state, servers: next }));
  } catch (error) {
    await Promise.all(next.map((server) => server.close().catch(state.report)));
    throw error;
  }
  const previous = state.servers;
  state.servers = next;
  notify(state);
  for (const server of previous) server.retire();
  const count = next.reduce((total, server) => total + server.tools.length, 0);
  return `Reloaded MCP configuration: ${next.length} enabled servers, ${count} discovered tools; code mode refreshed.`;
}

/** Fresh extension objects over the current contribution, not a mutable extension already held by a phase. */
function serverExtensions(state: ServerToolsState): readonly Extension[] {
  const taken = new Set<string>();
  const tools: ToolRegistration[] = [];
  for (const server of state.servers) {
    if (server.exposure === 'hidden') continue;
    for (const tool of server.tools) {
      const name = toolName(server.name, tool.name, taken);
      taken.add(name);
      tools.push(mcpTool(server, tool, name));
    }
  }
  const namespaces: CodemodeNamespace[] = state.servers.map((server) => {
    const description = server.config.description ?? server.instructions?.split('\n')[0];
    return {
      name: `mcp__${server.name}`,
      prefix: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
      ...(description ? { description } : {}),
      ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
    };
  });
  const searched = state.servers.some((server) => server.exposure === 'deferred' && server.tools.length > 0);
  return [
    createCodemodeExtension({ sandbox: state.sandbox, namespaces }),
    ...(tools.length === 0 ? [] : [defineExtension({ name: 'mcp', tools })]),
    ...(searched ? [createToolSearchExtension()] : []),
  ];
}

/** Called in the Chord factory: defer resource access until activation/commit, when the source becomes visible. */
export function serverToolSource(state: () => ServerToolsState, folder: () => string): ExtensionSource {
  return {
    extensions: () => serverExtensions(state()),
    subscribe(listener) {
      const listeners = state().listeners;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    reload: (validate) => reloadServerTools(state(), folder(), validate),
  };
}
