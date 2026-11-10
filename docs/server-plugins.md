# Server plugins, MCP and code mode

The server uses Pi Durable / Chord **1.5.2**, upstream tag `v1.5.2`, commit
`b4afddd`. Chord 1.5.1 made Chord v2 the package and removed v1, so the server follows v2's design
(`packages/chord/docs/design.md` §3 "The low-level host API", §6 "shared store, per-principal views", §13 natives,
§17 registries, §21 reload, §24 Durable), its plugins component (`src/node/plugins/README.md`) and Durable's
`test/examples/37-harness-registry.ts`, with Durable's README sections **Extensions**, **Reload** and **Code Mode**.

## What the server loads

The Chord host (`main.js`, `src/main.ts`) is the links' one server: it has the address `ServerHost()`
(`infinichat-remote/contract.ts`), and the apps are clients without one. It loads, in one publication: InfiniChat's
plugin (`plugins/infinichat/server.js`, `src/facet.ts`), the tools plugin (`src/tools-facet.ts`: code mode and MCP,
part of `main.js`), and the user's plugins from `~/.infinichat/plugins`. The first two get the process (its folder,
the machine's name, `loaded`, `fail`, `reloadPlugins`) as start data: each module exports a function of it that
returns the facet.

Each of the two has one object that lives as long as the host and owns its natives, opened with `self.open` and
closed in reverse (design §13): `infinichat.machine` holds the credential store, the provider sign-in, the other
machines' connections and the conversation's holder; `infinichat.tools` holds the code-mode sandbox and the MCP
servers. Their state is mirrored from those natives' own stores into `self.writable` values that an `onLive` routine
keeps current, and each member is a derive over one. The types clients hold, `infinichat.remote` and
`infinichat.mcp`, re-expose those objects' members, so every client reads the same state and none of it ends when
the last client leaves.

The conversation's Harness opens paused and resumes only once the host has loaded every plugin
(`ServerProcess.loaded`, which `main.ts` settles after the load): Durable reruns a replay-safe tool call
that a restart cut off only if its tool is installed when the call is recovered (Durable `docs/spec.md` §2.2,
`src/harness/tool.ts`). A conversation moved in later resumes at once. MCP tools appear only once their server has
connected and listed them, so an MCP call a script makes right after a restart can still fail.

Before it resumes, the server offers the model only code mode, as Durable's README shows it ("Who may call a tool":
`modelTools: [codemode]`): the main agent and its subagents write scripts, which call InfiniChat's tools, the MCP
tools and plugins' tools. A conversation held by the phone, which has no code mode, offers every tool again
(`OptChat.offer`). Without a registered `codemode` tool the server offers every tool too.

## The user's plugins

A plugin is a folder of `~/.infinichat/plugins` with a `package.json`, whose `name` is the plugin's (an npm package
name), and a `server.ts` (or `.tsx`, `.js`, `.mjs`) whose default export is a facet; or a single file
`<name>.server.ts` there. A folder without a `package.json` is reported and not loaded. Chord's plugins component
(`createPlugins`, `src/plugins.ts`) finds them, builds each facet into one script with esbuild (the plugin's own
files and the packages of its `dependencies` inlined), evaluates it and loads it beside the runtime's facets. A
plugin that fails to build or load is left out, and the others load.

A plugin imports the server's own instances of these packages, and nothing else from the runtime:
`@earendil-works/chord`, `@earendil-works/chord/context`, `@earendil-works/chord/json`, `@earendil-works/pi-ai`,
`@earendil-works/pi-durable` and `@earendil-works/pi-schema`. A facet only declares (design §16):

```ts
import { defineFacet, defineRegistry } from '@earendil-works/chord';
import { defineExtension, type Extension, type RegistrySnapshot } from '@earendil-works/pi-durable';

// A token of this name and version is the server's registry.
const Extensions = defineRegistry<readonly Extension[], RegistrySnapshot>('infinichat.extensions', { version: 1 });

export default defineFacet((_host, self) => {
  self.contribute(Extensions, [defineExtension({ name: 'hello', tools: [] })]);
});
```

The runtime ships esbuild as `esbuild-wasm` under the name `esbuild` (`runtime/package.json`): a release has one
runtime for every machine, and esbuild's native build is one package per platform.

## Reload from a client

`/reload-plugins` from the Mac or iOS client builds the user's plugins whose files changed since they were loaded and
those added since, and rolls them out on the host (`plugins.build`, `plugins.rollout`): Chord restarts each object of
a changed plugin, whose running calls finish on the old code, and leaves the others (design §21). A plugin whose new
code fails keeps its old code. Then it has the tools plugin read `mcp.json` again. InfiniChat's own plugin and the
tools plugin are passed as they are: only a release changes them, and a release restarts the server. The
conversation, its Harness and the clients' links stay as they are.
The reply says which plugins were added, reloaded or removed, which failed and why, which folders are no plugin, and
what happened to the MCP servers: connected, reconnected, closed, failed or unchanged, and which entries were skipped
and why.

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

Exposure: scripts call every registered tool. `direct` tools are declared in code mode's prompt section;
`codemode` (default, including its `codemode-deferred` alias) and `deferred` tools are left out of it, and scripts find
them with `searchTools()`. Durable's `tool_search` is not installed: the model is offered only code mode. `hidden`
tools are not registered. `toolExposure` overrides it per tool, as pi's coding agent reads it: exact tool names win
over `*` patterns, and the first matching pattern wins. This is not a separate per-server authorization boundary.

Scripts also get the coding agent's resource tools, `list_mcp_resources`, `list_mcp_resource_templates` and
`read_mcp_resource`, while a connected, non-hidden server offers resources; their exposure is the widest of those
servers'. A tool's progress notifications show as its running output. The servers get `~/.infinichat/work`, where the
agents' tools run, as their root, and the log messages they send go to `~/.infinichat/mcp.log` (moved to `mcp.log.1`
past 5 MB).

## OAuth and `/mcp`

The server's MCP client is pi-mcp 1.5.2, signed in the way pi's coding agent signs in (`docs/mcp.md` "Authenticate with
OAuth", `src/extensions/mcp/oauth.ts`). A streamable HTTP server without an `Authorization` header signs in with OAuth
when it answers 401: its connection fails as *needs sign-in*, and the user signs in from a client's `/mcp`. The
optional `oauth` entry takes the coding agent's `clientId`, `clientSecret`, `callbackPort`, `callbackUrl`, `scope`,
`clientName` and `authServerMetadataUrl`. Without `clientId` the server registers a client dynamically as InfiniChat:
the coding agent's Client ID Metadata Documents on pi.dev name pi, so `clientRegistration: "cimd"` is refused.

`/mcp` in the Mac or iOS app opens a sheet with the machine's servers (`InfiniChatMcp`, which the tools plugin serves):
each one's state, tools and resources, its error with a stdio server's stderr tail, sign-in and sign-out for OAuth
servers, and reconnect; and the entries the configuration skipped. A sign-in runs on the machine, as a provider
sign-in does (`SignInAttempts`, `pi/sign-in.ts`): the machine holds the PKCE verifier, the registration and the
tokens, in `~/.infinichat/mcp-auth.json` keyed by server name and URL, and refreshes them (pi-mcp's
`adaptOAuthProvider`). Its authorization URL redirects to the machine's own loopback, which its callback server
answers when the browser runs there. A client's browser runs elsewhere, so the client listens on the same loopback
port and path, catches the callback (`sign-in-attempt.ts` `loopbackRedirect`, the phone's `pi-oauth-callback` and the
Mac's `SignInRelay`) and hands it to the attempt's `manual_code` prompt; the user can also paste the return URL. A
connection never starts a sign-in itself: without a refresh token, or when the server asks for more scope, it needs one.

A dropped connection reconnects at the next call. A streamable HTTP session the server forgot, after a restart or a
deploy, is replaced once for that request, so the server needs no reload.

## How a reload treats servers

A Chord native never changes while its object lives, and a reload restarts only the objects of plugins whose code
changed (design §13, §21), so the tools plugin's object applies the configuration itself (`McpServers.apply`): at its
start, and whenever `/reload-plugins` calls its `mcp` method. It reads `mcp.json` and compares each enabled server's
version, a hash of its resolved connection (command, args, env and cwd, or url, headers and oauth, and timeout), with
the one it holds. So a reload connects added servers, replaces changed ones, retires removed or disabled ones, and
leaves the others connected; a change of only `exposure` or `description` republishes the tools without
reconnecting. A server left unchanged that isn't connected, for example one that was down, is tried again.

A server connects and lists its tools in the background, so one that fails never fails the start or the reload; the
reply, `/mcp` and the server's log report it. `notifications/tools/list_changed` republishes the tools without a
reload. A malformed or unreadable `mcp.json` is
reported and configures no server, so every server closes and code mode stays; fix it and reload. Calls already
running finish on their old connection, which closes once they settle.

## Extensions

`src/registry.ts` defines the Chord registry `infinichat.extensions`, whose composed value is Durable's registry
snapshot (`composeExtensions`), as Durable's `test/examples/37-harness-registry.ts` composes one. A contributor has
one value per registry (design §17), so each contributes a list of Durable `Extension`s: a facet with
`self.contribute(Extensions, [...])`, as InfiniChat's own facet does, so they are in the table before the Harness
opens; or an object that lives as long as the host with a watchable of one, as the tools plugin's object does,
because a server's tools arrive after it connects and change when it says so. The Harness reads the composition
through Durable's own `registryReader`. Chord orders the table by plugin name: of two plugins contributing an
extension of one name the first by name is installed, and the other is reported in the reply and left out, as is one
Durable refuses.

At shutdown the host closes its links, then ends its objects, the last to go live first. A running script finds its
sandbox closed and waits for the Harness's abort, so it resumes at the next start (durable
`src/codemode/codemode.ts`); an MCP server closes once its calls settle, which the Harness's close aborts.

## Claude through Claude Code

On a machine, Claude goes through its Claude Code login instead of an Anthropic API key
(`src/claude-code.ts`): pi-claude-code's provider (github.com/earendil-works/pi-claude-code, pinned to a commit in
`package.json`; it is not on npm), registered as its own extension entry registers it, in place of pi-ai's Anthropic
provider. The phone and the Mac app's own chats keep the API-key provider: the provider drives the `claude` program,
which only a machine has. Claude Code keeps the login (`claude auth login` in the machine's terminal), so the
credential store has nothing for it: the Providers screens show what pi-ai's availability check finds
(`claude auth status`), read at the server's start and at each refresh of models. `claude` must be on the PATH of the
account's login shell, which starts the server. The provider starts a `claude` process for a conversation's requests
and keeps at most two warm for five minutes; the server ends them as it closes. The build copies the script the
provider runs as its tool inventory, `inert-mcp.mjs`, beside InfiniChat's plugin, and a release ships it in the
runtime.

## Release

The tools plugin is part of the runtime's `main.js`. The runtime tarball also holds
`plugins/infinichat/inert-mcp.mjs`, and the runtime key hashes `package-lock.json`, `main.js` and that script, so a
server whose runtime differs downloads the new one and restarts into it. `release.json` keeps its schema (`version`,
`runtime.key`/`sha256`, `plugin.sha256`). Run the server package's lint, typecheck, build and `check`, commit and
push, then run `pnpm release` there. `--latest=false` is intentional: GitHub Latest belongs to the Mac app, not the
server.

Release 4.0.0 is the first on Chord v2, whose link protocol an app built for an earlier release cannot speak, and
the reverse: an app asks a server behind it to update (`RemoteInfiniChat`), and says to update the app when the server
is ahead. Release the server before the apps that need it.

A server installed from a release checks at startup, daily, and on SIGHUP. It verifies downloaded artifacts, closes
its Harness and exits 75 for the service manager to restart it. Old runtime folders are cleaned on startup.

pi-durable migrates documents and tasks one way: once a newer release has opened the conversation, an older one
refuses it (Durable `docs/spec.md` §3.6, §11.2). So before a release first opens the database another release left,
the server copies it to `~/.infinichat/backup/before-<release>/infinichat.db` with SQLite's online backup, replacing
the copy the previous update made; `state.json`'s `opened` records the release that last opened it. To go back,
install the release that left the copy and put it in `~/.infinichat/data/` while the server is stopped.
