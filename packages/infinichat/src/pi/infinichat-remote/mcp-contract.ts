import { hostNamed, method, remote } from '@earendil-works/chord';
import { arr, bool, nul, num, obj, oneOf, opt, str, union, type Static } from '@earendil-works/pi-schema';

import { signInAttemptFields } from './sign-in-attempt';

/**
 * How a configured server's tools reach the model, as pi's coding agent names it (`docs/mcp.md` "Control tool
 * exposure"); `codemode-deferred` is read as `codemode`.
 */
export const McpExposureSchema = oneOf(['codemode', 'deferred', 'direct', 'hidden']);
export type McpExposure = Static<typeof McpExposureSchema>;

/**
 * One server of the machine's `~/.infinichat/mcp.json` as `/mcp` lists it, as the coding agent's `/mcp` shows its
 * servers: its connection's state, and `error` when it failed or dropped (a stdio server's stderr tail with it).
 * `signIn` is there for a streamable HTTP server that signs in with OAuth: whether this machine holds its credentials.
 */
export const McpServerStatusSchema = obj({
  name: str(),
  transport: oneOf(['stdio', 'http']),
  state: oneOf(['disabled', 'connecting', 'connected', 'needs-sign-in', 'failed', 'disconnected']),
  exposure: McpExposureSchema,
  tools: num(),
  resources: bool(),
  description: opt(str()),
  error: opt(str()),
  signIn: opt(obj({ signedIn: bool() }, { open: true })),
}, { open: true });
export type McpServerStatus = Static<typeof McpServerStatusSchema>;

/** The machine's latest MCP sign-in, until the next one starts; null before its first (`pi/sign-in.ts`). */
export const McpSignInAttemptSchema = union([nul(), obj({ ...signInAttemptFields, server: str() }, { open: true })]);
export type McpSignInAttempt = Static<typeof McpSignInAttemptSchema>;

/**
 * The machine's MCP servers as clients show them, the object of the server's tools plugin (`tools-facet.ts`), which
 * holds their connections: the servers, what its configuration skipped and why, and its sign-in under way. A client
 * signs in to a server as it signs in to a provider: the attempt runs on the machine, which keeps the credentials, and
 * the client's browser returns to the loopback redirect its prompt waits for (`sign-in-attempt.ts`).
 */
export const InfiniChatMcp = remote('infinichat.mcp', {
  version: 1,
  input: obj({}, { open: true }),
  host: hostNamed('infinichat-server'),
  variants: {
    owner: {
      state: {
        servers: arr(McpServerStatusSchema),
        problems: arr(str()),
        signInAttempt: McpSignInAttemptSchema,
      },
      methods: {
        // Starts a sign-in to `server`, ending one under way, and returns its number.
        signIn: method(obj({ server: str() }, { open: true }), num()),
        answer: method(obj({ promptId: num(), value: str() }, { open: true })),
        cancelSignIn: method(),
        // Deletes the server's stored credentials and disconnects it.
        signOut: method(obj({ server: str() }, { open: true })),
        // Connects the server again, with the credentials stored now.
        reconnect: method(obj({ server: str() }, { open: true })),
      },
    },
  },
});
