# Server plugins, MCP and code mode

The server uses Pi Durable / Chord **1.5.0**, upstream tag `v1.5.0`, commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`. The starting patterns are Chord's `packages/chord/docs/guide.md`
sections **Plugins**, **Declarations**, **Hot reload** (Resources) and **Durable**, and Durable's README sections
**Extensions**, **Reload** and **Code Mode** with `docs/spec.md` §7.4–7.5.

## What the server loads

The Chord host (`main.js`) loads, in order: InfiniChat's plugin (`plugins/infinichat/server.js`, `src/facet.ts`), the
tools plugin (`plugins/tools/server.js`, `src/tools-facet.ts`: code mode and MCP), and the user's plugins, each a
folder of `~/.infinichat/plugins` with a `server.ts`, `server.mts`, `server.js` or `server.mjs` facet.

The conversation's Harness opens paused, inside InfiniChat's plugin, and resumes only once the host has loaded all of
them (`ServerProcess.loaded`, which `main.ts` settles after the last plugin): Durable reruns a replay-safe tool call
that a restart cut off only if its tool is installed when the call is recovered (Durable `docs/spec.md` §2.2,
`src/harness/tool.ts`). A conversation moved in later resumes at once. MCP tools appear only once their server has
connected and listed them, so an MCP call a script makes right after a restart can still fail.

## Reload from a client

`/reload-plugins` from the Mac or iOS client reloads the tools plugin and the user's plugins in one Chord reload,
removes plugins whose folder is gone, then loads new folders. A plugin that failed to load, which Chord leaves
installed (Chord `docs/guide.md` "Startup readiness"), is removed and loaded again on its own, so the reply says
whether it starts now, and one that still fails leaves the others' reload as it is. InfiniChat's own plugin is not
reloaded: only a release changes it, and a release restarts the server. The conversation, its Harness and the
clients' links stay as they are.
The reply says which types Chord changed and what happened to the MCP servers: connected, reconnected, closed,
failed or unchanged, and which entries were skipped and why. A refused reload leaves everything as it was.

## MCP configuration

`~/.infinichat/mcp.json` uses an `mcpServers` object:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["/path/to/server.mjs"],
      "exposure": "codemode"
    }
  }
}
```

A server can instead have a streamable HTTP `url` and optional `headers`. Stdio supports `args`, `env`, and `cwd`.
`${NAME}` in `env`, `headers` and `oauth.clientSecret` values expands from the server process's environment; a name it
lacks skips that server, and the reply names the variable. A leading `~/` in command, arguments, or working directory
expands to the account's home. Common fields are `enabled`, `description`, `timeout` (seconds per MCP request; default
60, renewed by the server's progress notifications), `exposure`, and `toolExposure`. Legacy SSE is not implemented.

Exposure: `direct` tools are offered to the model; `codemode` (default, including its `codemode-deferred` alias) and
`deferred` tools are callable through code mode but omitted from its inline prompt declarations. A `deferred` server
also enables Durable's `tool_search`, which can load deferred tools for direct model calls. `hidden` tools are not
registered. `toolExposure` overrides it per tool, as pi's coding agent reads it: exact tool names win over `*`
patterns, and the first matching pattern wins. This is not a separate per-server authorization boundary.

The model also gets the coding agent's resource tools, `list_mcp_resources`, `list_mcp_resource_templates` and
`read_mcp_resource`, while a connected, non-hidden server offers resources; their exposure is the widest of those
servers'. A tool's progress notifications show as its running output. The servers get `~/.infinichat/work`, where the
agents' tools run, as their root, and the log messages they send go to `~/.infinichat/mcp.log` (moved to `mcp.log.1`
past 5 MB).

## OAuth and `/mcp`

The server's MCP client is pi-mcp 1.5.0, signed in the way pi's coding agent signs in (`docs/mcp.md` "Authenticate with
OAuth", `src/extensions/mcp/oauth.ts`). A streamable HTTP server without an `Authorization` header signs in with OAuth
when it answers 401: its connection fails as *needs sign-in*, and the user signs in from a client's `/mcp`. The
optional `oauth` entry takes the coding agent's `clientId`, `clientSecret`, `callbackPort`, `callbackUrl`, `scope`,
`clientName` and `authServerMetadataUrl`. Without `clientId` the server registers a client dynamically as InfiniChat:
the coding agent's Client ID Metadata Documents on pi.dev name pi, so `clientRegistration: "cimd"` is refused.

`/mcp` in the Mac or iOS app opens a sheet with the machine's servers (`InfiniChatMcp`, which the tools plugin serves):
each one's state, tools and resources, its error with a stdio server's stderr tail, sign-in and sign-out for OAuth
servers, and reconnect; and the entries the configuration skipped. A sign-in runs on the machine, as a provider
sign-in does (`SignInAttempts`, `node/sign-in.ts`): the machine holds the PKCE verifier, the registration and the
tokens, in `~/.infinichat/mcp-auth.json` keyed by server name and URL, and refreshes them (pi-mcp's
`adaptOAuthProvider`). Its authorization URL redirects to the machine's own loopback, which its callback server
answers when the browser runs there. A client's browser runs elsewhere, so the client listens on the same loopback
port and path, catches the callback (`sign-in-attempt.ts` `loopbackRedirect`, the phone's `pi-oauth-callback` and the
Mac's `SignInRelay`) and hands it to the attempt's `manual_code` prompt; the user can also paste the return URL. A
connection never starts a sign-in itself: without a refresh token, or when the server asks for more scope, it needs one.

A dropped connection reconnects at the next call. A streamable HTTP session the server forgot, after a restart or a
deploy, is replaced once for that request, so the server needs no reload.

## How a reload treats servers

The tools plugin's object reads `mcp.json` on every run and declares the code-mode sandbox and one Chord resource per
enabled server, named `mcp__<server>`, whose version is a hash of its resolved connection (command, args, env and
cwd, or url, headers and oauth, and timeout). Chord keeps a resource whose version is unchanged, opens a changed one beside
the old one, and closes one no longer declared. So a reload connects added servers, reconnects changed ones, closes
removed or disabled ones, and leaves the others connected; a change of only `exposure` or `description` republishes
the tools without reconnecting. A server left unchanged that isn't connected, for example one that was down, is
tried again.

A server connects and lists its tools in the background, so one that fails never fails the start or the reload; the
reply, `/mcp` and the server's log report it. `notifications/tools/list_changed` republishes the tools without a
reload. A malformed or unreadable `mcp.json` is
reported and configures no server, so every server closes and code mode stays; fix it and reload. Calls already
running finish on their old connection, which closes once they settle.

## Extensions

`src/registry.ts` defines the Chord registry `infinichat.extensions`. Host-lifetime plugin objects register Durable
`Extension`s with `self.register(Extensions, ...)`. The tools plugin registers an `ExtensionSource` instead
(`extensions()` and `subscribe()`), because a server's tools arrive after it connects while a registration changes
only with a reload. InfiniChat's `durableRegistry` is Durable's `RegistryReader` over these tables, which Chord leaves
to the application (spec §8): one complete snapshot per table and per source change, resubscribing whenever a commit
swaps the table, so a reload or removal of a plugin replaces or withdraws exactly what it registered. Two plugins
contributing one extension name are refused; the Harness keeps its previous snapshot and the reply says so.

At shutdown the host disposes the tools plugin's object before or with InfiniChat's. A running script finds its
sandbox closed and waits for the Harness's abort, so it resumes at the next start (durable
`src/codemode/codemode.ts`); an MCP server closes once its calls settle, which the Harness's close aborts.

## Release

The tools plugin is part of the runtime: the runtime tarball holds `plugins/tools/server.js`, and the runtime key
hashes `package-lock.json`, `main.js` and that plugin, so a server whose runtime differs downloads the new one and
restarts into it. `release.json` keeps its schema (`version`, `runtime.key`/`sha256`, `plugin.sha256`). Run the
server package's lint, typecheck, build and `check`, commit and push, then run `pnpm release` there. `--latest=false`
is intentional: GitHub Latest belongs to the Mac app, not the server.

A server installed from a release checks at startup, daily, and on SIGHUP. It verifies downloaded artifacts, closes
its Harness and exits 75 for the service manager to restart it. Old runtime folders are cleaned on startup.

pi-durable migrates documents and tasks one way: once a newer release has opened the conversation, an older one
refuses it (Durable `docs/spec.md` §3.6, §11.2). So before a release first opens the database another release left,
the server copies it to `~/.infinichat/backup/before-<release>/infinichat.db` with SQLite's online backup, replacing
the copy the previous update made; `state.json`'s `opened` records the release that last opened it. To go back,
install the release that left the copy and put it in `~/.infinichat/data/` while the server is stopped.
