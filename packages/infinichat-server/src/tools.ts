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

import type { LiveExtensions } from './registry';

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

/** One configured server: its client while connected, and the tools and instructions it last listed. */
class McpServer {
  tools: readonly Tool[] = [];
  instructions?: string;
  private client?: McpClient;
  private connecting?: Promise<McpClient>;
  private closed = false;

  constructor(readonly name: string, readonly config: ServerConfig, private readonly changed: () => void) {}

  get exposure(): Exposure {
    const exposure = this.config.exposure ?? 'codemode';
    return exposure === 'codemode-deferred' ? 'codemode' : exposure;
  }

  /** The connected client, connecting when there is none: a dropped connection reconnects on the next call. */
  connect(): Promise<McpClient> {
    if (this.closed) return Promise.reject(new Error(`MCP server ${this.name} is closed.`));
    if (this.client?.connectionState === 'connected') return Promise.resolve(this.client);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<CallToolResult> {
    return (await this.connect()).callTool(tool, args, { signal });
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    await client?.close();
  }

  private transport(): McpTransport {
    const { config } = this;
    if ('url' in config) return new StreamableHttpTransport({ url: config.url, headers: expandAll(config.headers) });
    return new StdioTransport({
      command: home(config.command),
      args: config.args?.map(home),
      env: expandAll(config.env),
      // A relative folder is the account's home's, where the server runs.
      cwd: config.cwd === undefined ? undefined : resolve(homedir(), home(config.cwd)),
    });
  }

  private async open(): Promise<McpClient> {
    const client = new McpClient({ name: 'infinichat', version: INFINICHAT_SERVER_VERSION,
      requestTimeoutMs: (this.config.timeout ?? DEFAULT_TIMEOUT) * 1000 });
    await client.connect(this.transport());
    if (this.closed) {
      await client.close();
      throw new Error(`MCP server ${this.name} is closed.`);
    }
    this.client = client;
    client.onClose(() => {
      if (this.client === client) this.client = undefined;
    });
    // New tools are added and withdrawn ones become unreachable, as the coding agent follows a changed list.
    client.onNotification('notifications/tools/list_changed', () => {
      void this.list(client).catch((error: unknown) => console.error(`MCP server ${this.name}:`, error));
    });
    this.instructions = client.instructions;
    await this.list(client);
    return client;
  }

  private async list(client: McpClient): Promise<void> {
    this.tools = await client.listTools();
    this.changed();
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

/**
 * The tools InfiniChat's server adds by default: pi's code mode (`@earendil-works/pi-durable/codemode`, its scripts
 * run by `CodemodeSandbox` in worker threads, pi-codemode's defaults), and the tools of the MCP servers
 * `~/.infinichat/mcp.json` configures, in the `mcpServers` format pi's coding agent and other MCP clients read
 * (coding-agent `docs/mcp.md` "Configure servers"). Servers connect in the background, so a server's tools reach the
 * Harness once it has listed them (`LiveExtensions`); a server named in a script is grouped as its codemode namespace.
 * The process owns the connections and the sandbox, and `close` ends them after the conversation has closed.
 */
export class ServerTools implements LiveExtensions {
  private readonly sandbox = new CodemodeSandbox();
  private readonly toolSearch = createToolSearchExtension();
  private readonly listeners = new Set<() => void>();
  private readonly servers: McpServer[] = [];

  /** Reads `mcp.json` in `folder` (`~/.infinichat`); without it there are no MCP servers. */
  static async open(folder: string, report: (message: string) => void): Promise<ServerTools> {
    const tools = new ServerTools();
    const text = await readFile(join(folder, 'mcp.json'), 'utf8').catch(() => undefined);
    if (text === undefined) return tools;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      report('~/.infinichat/mcp.json is not valid JSON, so no MCP server connects.');
      return tools;
    }
    if (!Check(ConfigFileSchema, parsed)) {
      report('~/.infinichat/mcp.json needs an mcpServers object, so no MCP server connects.');
      return tools;
    }
    const seen = new Set<string>();
    for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
      const config = parseServer(name, entry);
      // Names that differ only in - and _ name one server, as the coding agent counts them.
      const key = name.replace(/-/g, '_');
      if (typeof config === 'string') report(config);
      else if (seen.has(key)) report(`MCP server ${name} repeats another server's name.`);
      else if (config.enabled !== false) tools.servers.push(new McpServer(name, config, () => tools.notify()));
      seen.add(key);
    }
    // Invalid entries and failed connections are reported and skip only that server.
    for (const server of tools.servers) {
      server.connect().catch((error: unknown) => {
        report(`MCP server ${server.name} could not connect: ${error instanceof Error ? error.message : error}`);
      });
    }
    return tools;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  extensions(): readonly Extension[] {
    const taken = new Set<string>();
    const tools: ToolRegistration[] = [];
    for (const server of this.servers) {
      if (server.exposure === 'hidden') continue;
      for (const tool of server.tools) {
        const name = toolName(server.name, tool.name, taken);
        taken.add(name);
        tools.push(mcpTool(server, tool, name));
      }
    }
    const namespaces: CodemodeNamespace[] = this.servers.map((server) => {
      // Its description, else the first line of its instructions, as the coding agent describes a server.
      const description = server.config.description ?? server.instructions?.split('\n')[0];
      return {
        name: `mcp__${server.name}`,
        prefix: `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
        ...(description ? { description } : {}),
        ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
      };
    });
    // `tool_search` loads deferred tools for the model, which the coding agent activates for `deferred` servers.
    const searched = this.servers.some((server) => server.exposure === 'deferred' && server.tools.length > 0);
    return [
      createCodemodeExtension({ sandbox: this.sandbox, namespaces }),
      ...(tools.length === 0 ? [] : [defineExtension({ name: 'mcp', tools })]),
      ...(searched ? [this.toolSearch] : []),
    ];
  }

  async close(): Promise<void> {
    await Promise.all(this.servers.map((server) => server.close().catch(() => {})));
    await this.sandbox.close();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
