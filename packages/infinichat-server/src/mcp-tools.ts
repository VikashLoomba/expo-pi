import { createHash } from 'node:crypto';

import { copyJson } from '@earendil-works/chord/json';
import type { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { defineExtension, defineTool, type Extension, type ToolRegistration } from '@earendil-works/pi-durable';
import { createCodemodeExtension, type CodemodeNamespace } from '@earendil-works/pi-durable/codemode';
import { toLlmContent, type ContentBlock, type Tool } from '@earendil-works/pi-mcp';
import { arr, bool, obj, opt, str, unknown, type Schema } from '@earendil-works/pi-schema';
import type { McpExposure } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';

import { toolExposure, type McpServerConfig } from './mcp-config';
import type { McpServer } from './mcp-server';

/** Provider tool names are at most 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME = 64;
/** The resource tools Codex and opencode use, which the coding agent adds too (`docs/mcp.md` "Use resources"). */
const LIST_RESOURCES = 'list_mcp_resources';
const LIST_TEMPLATES = 'list_mcp_resource_templates';
const READ_RESOURCE = 'read_mcp_resource';

/** What scripts get for a call, the coding agent's: the server's `CallToolResult` without `_meta`. */
const CallResultSchema = obj({
  content: arr(unknown()),
  structuredContent: opt(unknown()),
  isError: opt(bool()),
}, { open: true });
const ListedSchema = obj({
  server: opt(str()),
  resources: arr(obj({ server: str(), uri: str(), name: str() }, { open: true })),
  nextCursor: opt(str()),
  errors: opt(arr(obj({ server: str(), error: str() }, { open: true }))),
}, { open: true });
const ListedTemplatesSchema = obj({
  server: opt(str()),
  resourceTemplates: arr(obj({ server: str(), uriTemplate: str(), name: str() }, { open: true })),
  nextCursor: opt(str()),
  errors: opt(arr(obj({ server: str(), error: str() }, { open: true }))),
}, { open: true });
const ReadSchema = obj({ server: str(), uri: str(), contents: arr(unknown()) }, { open: true });
const ListParameters = obj({
  server: opt(str({ description: 'MCP server name. Omit to list every server with resources.' })),
  cursor: opt(str({ description: 'Opaque cursor from a previous call with the same server; omit for the first page.' })),
});
const ReadParameters = obj({
  server: str({ description: 'MCP server name exactly as configured. Must match the \'server\' field returned by '
    + 'list_mcp_resources.' }),
  uri: str({ description: 'Resource URI to read. Must be one of the URIs returned by list_mcp_resources.' }),
});

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A configured server and its connection, as the tools plugin's object declares them (`tools-facet.ts`). */
export interface ConnectedServer {
  readonly config: McpServerConfig;
  readonly server: McpServer;
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
 * `tool`'s input schema as providers take it: an object schema, which some reject without `properties` (pi-mcp
 * README). Typed as the objects it accepts, as pi-schema's builders type the JSON Schema they return: the Harness
 * validates a call's arguments against it before `execute`.
 */
function mcpParameters(tool: Tool): Schema<Record<string, unknown>> {
  return { ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} };
}

/**
 * A pi-durable tool calling `tool` of `server`; its result reaches the model as text and images, and scripts whole.
 * Progress goes out as the call's running output, as the mcp-codemode example forwards it to `onUpdate`
 * (`packages/agent/examples/mcp-codemode/tools.ts`), and asking for it renews the request's timeout (pi-mcp README).
 */
function mcpTool(server: McpServer, exposure: McpExposure, tool: Tool, name: string): ToolRegistration {
  return defineTool({
    name,
    description: tool.description ?? tool.title ?? `${tool.name} of the MCP server ${server.name}`,
    parameters: mcpParameters(tool),
    structuredOutputSchema: CallResultSchema,
    ...(exposure === 'direct' ? {} : { deferred: true as const }),
    async execute(args, api, context) {
      const result = await server.call(tool.name, args, context.abortSignal, (progress) => {
        const total = progress.total === undefined ? '' : `/${progress.total}`;
        api.output(`${progress.message ?? `Progress ${progress.progress}${total}`}\n`);
      });
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

/** MCP Apps' user interfaces, which only hosts that render them can use (coding-agent `resources.ts:46-50`). */
function isMcpAppResource(item: { uri?: string; uriTemplate?: string; mimeType?: string }): boolean {
  const uri = item.uri ?? item.uriTemplate ?? '';
  return uri.startsWith('ui://') || /;\s*profile\s*=\s*"?mcp-app"?/i.test(item.mimeType ?? '');
}

/** A listed resource or template without `_meta` and icons, tagged with its server. */
function listed<T extends { _meta?: unknown; icons?: unknown }>(server: string, item: T) {
  const { _meta, icons, ...rest } = item;
  return { server, ...rest };
}

/**
 * The coding agent's three resource tools (`src/extensions/mcp/resources.ts`), over the connected servers that offer
 * resources: listings are JSON, `{ server?, resources, nextCursor? }`, a page of one server or every page of every
 * server; a read reaches the model as pi-mcp's `toLlmContent` has it and scripts as the server's contents. Their
 * exposure is the widest among those servers': `direct`, then `codemode`, then `deferred` (`syncResourceTools`).
 */
function resourceTools(servers: readonly McpServer[], exposure: McpExposure): ToolRegistration[] {
  const deferred = exposure === 'direct' ? {} : { deferred: true as const };
  const find = (name: string): McpServer => {
    const server = servers.find((candidate) => candidate.name === name);
    if (server) return server;
    const available = servers.map((candidate) => candidate.name).join(', ');
    throw new Error(`MCP server ${name} has no resources${available ? `. Servers with resources: ${available}` : ''}.`);
  };
  const json = (payload: object) => ({ output: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredOutput: copyJson(payload) });
  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name));
  /** Every page of every server, with the servers that failed. */
  const everyServer = async <T>(list: (server: McpServer) => Promise<T[]>) => {
    const results = await Promise.allSettled(sorted.map(list));
    const items: (T & { server: string })[] = [];
    const errors: { server: string; error: string }[] = [];
    results.forEach((result, index) => {
      const server = sorted[index].name;
      if (result.status === 'fulfilled') items.push(...result.value.map((item) => ({ ...item, server })));
      else errors.push({ server, error: message(result.reason) });
    });
    return { items, ...(errors.length > 0 ? { errors } : {}) };
  };
  return [
    defineTool({
      name: LIST_RESOURCES,
      description: 'Lists resources provided by MCP servers. Resources allow servers to share data that provides context '
        + 'to language models, such as files, database schemas, or application-specific information. Prefer resources '
        + 'over web search when possible.',
      parameters: ListParameters,
      structuredOutputSchema: ListedSchema,
      replay: 'safe',
      ...deferred,
      async execute({ server, cursor }, _api, context) {
        if (server !== undefined) {
          const found = find(server);
          const page = await found.resourcesPage(cursor, context.abortSignal);
          return json({ server: found.name, resources: page.resources.filter((item) => !isMcpAppResource(item))
            .map((item) => listed(found.name, item)), ...(page.nextCursor === undefined ? {} : { nextCursor:
            page.nextCursor }) });
        }
        if (cursor !== undefined) throw new Error('cursor can only be used when a server is specified.');
        const { items, ...rest } = await everyServer((found) => found.allResources(context.abortSignal));
        return json({ resources: items.filter((item) => !isMcpAppResource(item))
          .map((item) => listed(item.server, item)), ...rest });
      },
    }),
    defineTool({
      name: LIST_TEMPLATES,
      description: 'Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to '
        + 'share data that takes parameters and provides context to language models, such as files, database schemas, '
        + 'or application-specific information. Prefer resource templates over web search when possible.',
      parameters: ListParameters,
      structuredOutputSchema: ListedTemplatesSchema,
      replay: 'safe',
      ...deferred,
      async execute({ server, cursor }, _api, context) {
        if (server !== undefined) {
          const found = find(server);
          const page = await found.resourceTemplatesPage(cursor, context.abortSignal);
          return json({ server: found.name, resourceTemplates: page.resourceTemplates
            .filter((item) => !isMcpAppResource(item)).map((item) => listed(found.name, item)),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
        }
        if (cursor !== undefined) throw new Error('cursor can only be used when a server is specified.');
        const { items, ...rest } = await everyServer((found) => found.allResourceTemplates(context.abortSignal));
        return json({ resourceTemplates: items.filter((item) => !isMcpAppResource(item))
          .map((item) => listed(item.server, item)), ...rest });
      },
    }),
    defineTool({
      name: READ_RESOURCE,
      description: 'Read a specific resource from an MCP server given the server name and resource URI.',
      parameters: ReadParameters,
      structuredOutputSchema: ReadSchema,
      replay: 'safe',
      ...deferred,
      async execute({ server, uri }, _api, context) {
        const found = find(server);
        const result = await found.readResource(uri, context.abortSignal);
        // Several contents (for example a directory) are labeled with their URIs.
        const blocks: ContentBlock[] = result.contents.flatMap((contents) => [
          ...(result.contents.length > 1 ? [{ type: 'text' as const, text: `${contents.uri}:` }] : []),
          { type: 'resource' as const, resource: contents },
        ]);
        const output = toLlmContent({ content: blocks });
        const contents = result.contents.map(({ _meta, ...rest }) => rest);
        return {
          output: output.length > 0 ? output : [{ type: 'text', text: `Resource ${uri} is empty.` }],
          structuredOutput: copyJson({ server: found.name, uri, contents }),
        };
      },
    }),
  ];
}

/**
 * Code mode over `sandbox`, with a namespace per server, the servers' tools as they last listed them, and the resource
 * tools while a server offers resources: fresh extension objects on every call, never one a running phase already
 * holds.
 */
export function serverExtensions(sandbox: CodemodeSandbox, servers: readonly ConnectedServer[]): readonly Extension[] {
  const taken = new Set<string>();
  const tools: ToolRegistration[] = [];
  for (const { config, server } of servers) {
    for (const tool of server.tools) {
      const exposure = toolExposure(config, tool.name);
      if (exposure === 'hidden') continue;
      const name = toolName(config.name, tool.name, taken);
      taken.add(name);
      tools.push(mcpTool(server, exposure, tool, name));
    }
  }
  const readable = servers.filter(({ config, server }) => config.exposure !== 'hidden' && server.hasResources);
  const exposures = new Set(readable.map(({ config }) => config.exposure));
  const widest = (['direct', 'codemode', 'deferred'] as const).find((exposure) => exposures.has(exposure));
  if (widest !== undefined) tools.push(...resourceTools(readable.map(({ server }) => server), widest));
  const namespaces: CodemodeNamespace[] = servers.map(({ config, server }) => {
    const description = config.description ?? server.instructions?.split('\n')[0];
    return {
      name: `mcp__${config.name}`,
      prefix: `mcp__${config.name.replace(/[^A-Za-z0-9_]/g, '_')}__`,
      ...(description ? { description } : {}),
      ...(server.instructions === undefined ? {} : { instructions: server.instructions }),
    };
  });
  return [
    createCodemodeExtension({ sandbox, namespaces }),
    ...(tools.length === 0 ? [] : [defineExtension({ name: 'mcp', tools })]),
  ];
}
