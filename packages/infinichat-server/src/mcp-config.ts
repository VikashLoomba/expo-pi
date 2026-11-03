import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { McpExposure } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import {
  arr, bool, compile, int, map, num, obj, oneOf, opt, str, unknown, type Static,
} from '@earendil-works/pi-schema';

/**
 * How a server's tools reach code mode's scripts, as pi's coding agent configures it (coding-agent `docs/mcp.md`,
 * "Control tool exposure"); the model is offered only code mode (`conversation.ts`). `direct` tools are declared in the
 * `codemode` section; `codemode`, the default, and `deferred` are pi-durable's deferred tools, which scripts find with
 * `searchTools()` but the section leaves out (durable README "Who may call a tool"); `hidden` ones are not registered.
 */
const ExposureSchema = oneOf(['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden']);
type ConfiguredExposure = Static<typeof ExposureSchema>;
/** The coding agent's `oauth` entry (`src/core/mcp-servers.ts`, `McpOAuthConfig`), less pi.dev's client documents. */
const OAuthSchema = obj({
  clientId: opt(str({ minLength: 1 })),
  clientSecret: opt(str()),
  callbackPort: opt(int({ minimum: 1, maximum: 65535 })),
  callbackUrl: opt(str()),
  scope: opt(str()),
  clientName: opt(str({ minLength: 1 })),
  clientRegistration: opt(oneOf(['auto', 'dcr', 'cimd'])),
  authServerMetadataUrl: opt(str()),
}, { open: true });
const common = {
  type: opt(oneOf(['stdio', 'http', 'streamable-http'])),
  enabled: opt(bool()),
  description: opt(str()),
  /** Seconds per request, pi-mcp's `requestTimeoutMs`; progress notifications renew it. */
  timeout: opt(num({ exclusiveMinimum: 0 })),
  exposure: opt(ExposureSchema),
  /** Exposure per tool: exact names win over `*` patterns, and the first pattern that matches wins. */
  toolExposure: opt(map(ExposureSchema)),
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
  oauth: opt(OAuthSchema),
}, { open: true })).check;
const isConfigFile = compile(obj({ mcpServers: opt(map(unknown())) }, { open: true })).check;

const NAME = /^[A-Za-z0-9_-]+$/;
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
/** The configuration as the user knows it, in messages. */
export const MCP_CONFIG = '~/.infinichat/mcp.json';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A server's OAuth client, resolved: the coding agent's `McpOAuthSettings` (`src/extensions/mcp/oauth.ts`). */
export interface McpOAuthSettings {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly callbackPort?: number;
  readonly callbackUrl?: string;
  readonly scope?: string;
  readonly clientName?: string;
  readonly authServerMetadataUrl?: string;
}

/** What a server's connection is made with, resolved; a change of any of it reconnects the server. */
export type McpConnection = { readonly timeout?: number } & ({
  readonly url: string; readonly headers?: Readonly<Record<string, string>>;
  /** Present when the server signs in with OAuth: an HTTP server without an `Authorization` header. */
  readonly oauth?: McpOAuthSettings;
} | {
  readonly command: string; readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
});

/** An enabled server of the configuration. */
export interface McpServerConfig {
  readonly name: string;
  readonly exposure: McpExposure;
  /** `toolExposure` in its order: exact names first, then patterns. */
  readonly toolExposure: readonly (readonly [string, McpExposure])[];
  readonly description?: string;
  readonly connection: McpConnection;
  /** Its resource's version, a hash of `connection`: Chord reopens a resource whose version changed. */
  readonly version: number;
}

/** A server the configuration turns off, which `/mcp` still lists. */
export interface McpDisabledServer {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  readonly exposure: McpExposure;
  readonly description?: string;
}

/** The enabled servers, the disabled ones, and why the others are left out. */
export interface McpConfiguration {
  readonly servers: readonly McpServerConfig[];
  readonly disabled: readonly McpDisabledServer[];
  readonly problems: readonly string[];
}

/**
 * `${NAME}` from this process's environment, as the coding agent expands `env` and `headers` values. A name the
 * environment lacks goes into `missing`, which skips the server: an empty value would fail it in a less clear way.
 */
function expandValue(value: string, missing: Set<string>): string {
  return value.replace(VARIABLE, (_match, name: string) => {
    if (process.env[name] === undefined) missing.add(name);
    return process.env[name] ?? '';
  });
}

function expand(values: Readonly<Record<string, string>> | undefined, missing: Set<string>) {
  return values === undefined ? undefined
    : Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandValue(value, missing)]));
}

/** A leading `~/` names the home folder, as the coding agent reads `command`, `args` and `cwd`. */
const home = (value: string) => value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;

const configured = (exposure: ConfiguredExposure | undefined): McpExposure =>
  exposure === undefined || exposure === 'codemode-deferred' ? 'codemode' : exposure;

/** A URL on a loopback host, as the coding agent requires of a callback and allows of a metadata document. */
function loopbackUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return LOOPBACK.has(url.hostname) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** `oauth` resolved, or why it can't be: the coding agent's checks (`src/core/mcp-servers.ts`, `validateOAuth`). */
function oauthSettings(oauth: Static<typeof OAuthSchema> | undefined, missing: Set<string>): McpOAuthSettings | string {
  if (oauth === undefined) return {};
  if (oauth.clientRegistration === 'cimd') {
    return 'oauth.clientRegistration "cimd" needs a Client ID Metadata Document, which InfiniChat has none of.';
  }
  if (oauth.callbackUrl !== undefined) {
    const callback = loopbackUrl(oauth.callbackUrl);
    if (callback?.protocol !== 'http:' || callback.search || callback.hash) {
      return 'oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment.';
    }
    if (callback.port && oauth.callbackPort !== undefined && Number(callback.port) !== oauth.callbackPort) {
      return 'oauth.callbackUrl and oauth.callbackPort name different ports.';
    }
  }
  if (oauth.authServerMetadataUrl !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(oauth.authServerMetadataUrl);
    } catch {
      url = undefined;
    }
    if (url?.protocol !== 'https:' && !(url?.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
      return 'oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1].';
    }
  }
  const { clientId, callbackPort, callbackUrl, scope, clientName, authServerMetadataUrl } = oauth;
  const clientSecret = oauth.clientSecret === undefined ? undefined : expandValue(oauth.clientSecret, missing);
  return Object.fromEntries(Object.entries({ clientId, clientSecret, callbackPort, callbackUrl, scope, clientName,
    authServerMetadataUrl }).filter(([, value]) => value !== undefined));
}

type Parsed = McpServerConfig | McpDisabledServer | string;

/** A configured server's entry, resolved, or why it is skipped: the coding agent's rules, less what this lacks. */
function parseServer(name: string, entry: unknown): Parsed {
  const skipped = (reason: string) => `MCP server ${name} skipped: ${reason}`;
  if (!NAME.test(name)) return skipped('a name may contain only letters, digits, _ and -.');
  const stdio = isStdioServer(entry) && entry.type !== 'http' && entry.type !== 'streamable-http' ? entry : undefined;
  const http = isHttpServer(entry) && entry.type !== 'stdio' ? entry : undefined;
  const config = stdio ?? http;
  if (config === undefined) return skipped('it needs a command (stdio) or a url (streamable HTTP), not SSE.');
  const exposure = configured(config.exposure);
  const description = config.description === undefined ? {} : { description: config.description };
  if (config.enabled === false) return { name, transport: stdio ? 'stdio' : 'http', exposure, ...description };
  const missing = new Set<string>();
  let connection: McpConnection;
  if (stdio !== undefined) {
    connection = { command: home(stdio.command), args: stdio.args?.map(home), env: expand(stdio.env, missing),
      cwd: stdio.cwd === undefined ? undefined : resolve(homedir(), home(stdio.cwd)), timeout: stdio.timeout };
  } else if (http !== undefined) {
    const headers = expand(http.headers, missing);
    // OAuth applies to HTTP servers without an `Authorization` header (coding-agent `runtime.ts:83`).
    const authorized = Object.keys(headers ?? {}).some((header) => header.toLowerCase() === 'authorization');
    const oauth = authorized ? {} : oauthSettings(http.oauth, missing);
    if (typeof oauth === 'string') return skipped(oauth);
    connection = { url: http.url, headers, timeout: http.timeout, ...(authorized ? {} : { oauth }) };
  } else {
    return skipped('it needs a command (stdio) or a url (streamable HTTP), not SSE.');
  }
  if (missing.size > 0) return skipped(`the server’s environment has no ${[...missing].join(', ')}.`);
  const overrides = Object.entries(config.toolExposure ?? {}).map(([tool, value]) => [tool, configured(value)] as const);
  // 48 bits of the hash, an integer Chord takes as a version.
  const version = Number.parseInt(createHash('sha256').update(JSON.stringify(connection)).digest('hex').slice(0, 12),
    16);
  return { name, exposure, ...description, connection, version,
    toolExposure: [...overrides.filter(([tool]) => !tool.includes('*')),
      ...overrides.filter(([tool]) => tool.includes('*'))] };
}

/** `*` matches any characters; everything else matches itself. */
const pattern = (value: string) =>
  new RegExp(`^${value.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

/** The exposure of `tool`, as the coding agent's `getMcpToolExposure` picks it. */
export function toolExposure(config: McpServerConfig, tool: string): McpExposure {
  for (const [name, exposure] of config.toolExposure) {
    if (name.includes('*') ? pattern(name).test(tool) : name === tool) return exposure;
  }
  return config.exposure;
}

/**
 * `file`, read synchronously, as a Chord factory declares (chord `docs/guide.md` "Serving objects"). A file that is
 * missing configures no server; one that can't be read or parsed configures none either, and says why, as does each
 * entry that is left out.
 */
export function mcpConfiguration(file: string): McpConfiguration {
  const none = (problem: string) => ({ servers: [], disabled: [], problems: [`${problem} No MCP server is connected.`] });
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { servers: [], disabled: [], problems: [] };
    }
    return none(`${MCP_CONFIG} could not be read: ${message(error)}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return none(`${MCP_CONFIG} is not valid JSON: ${message(error)}.`);
  }
  if (!isConfigFile(parsed)) return none(`${MCP_CONFIG} needs an mcpServers object.`);
  const servers: McpServerConfig[] = [];
  const disabled: McpDisabledServer[] = [];
  const problems: string[] = [];
  // Tool and namespace names write `-` as `_`, so two names that differ only there would collide.
  const keys = new Set<string>();
  for (const [name, entry] of Object.entries(parsed.mcpServers ?? {})) {
    const server = parseServer(name, entry);
    if (typeof server === 'string') {
      problems.push(server);
      continue;
    }
    const key = name.replace(/-/g, '_');
    if (keys.has(key)) {
      problems.push(`MCP server ${name} skipped: another server’s name differs from it only in - and _.`);
      continue;
    }
    keys.add(key);
    if ('connection' in server) servers.push(server);
    else disabled.push(server);
  }
  return { servers, disabled, problems };
}
