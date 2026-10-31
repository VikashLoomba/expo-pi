# Server plugins, MCP and code mode

The server uses Pi Durable / Chord **1.4.0**, upstream tag `v1.4.0`, commit
`4a080252f06caf63a525d7873c5d94d3c23887e0`. The starting patterns are Chord's
`packages/chord/docs/guide.md` sections **Plugins**, **Hot reload**, and **Durable**, and Durable's
`packages/durable/test/examples/10-registry-reload.ts` and `31-reload-and-restart.ts`.

## Reload from a client

Send `/reload-plugins` from the Mac or iOS client while InfiniChat runs on a server. It:

1. Reloads the built-in InfiniChat facet and installed facets under `~/.infinichat/plugins`, loads newly added
   folders, and removes deleted ones. A user facet's entry is `server.ts`, `server.mts`, `server.js`, or `server.mjs`.
2. Explicitly refreshes configuration for dynamic extension contributors, including `~/.infinichat/mcp.json`.
   Chord keeps an unchanged resource across a code reload; its `open` callback is not a configuration reload hook.
3. Reports plugin-code, MCP discovery/configuration, and Durable registry-publication outcomes separately.

The command works with no user-installed plugins. It does not reopen the conversation database, restart the
Harness, reconnect clients, or close the code-mode sandbox. A **server release update** is different: it restarts
into the new runtime, and Durable resumes unfinished work.

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
`${NAME}` in explicit environment/header values expands from the server process environment. A leading `~/` in
command, arguments, or working directory expands to the account's home. Common fields are `enabled`, `description`,
`timeout` (seconds per MCP request; default 60), and `exposure`. OAuth and legacy SSE are not implemented.

Exposure retains the server's existing behavior: `direct` tools are offered to the model; `codemode` (default,
including its `codemode-deferred` alias) and `deferred` tools are callable through code mode but omitted from its
inline prompt declarations. A `deferred` server also enables Durable's `tool_search`, which can load deferred tools
for direct model calls. `hidden` tools are not registered. This is not a separate per-server authorization boundary.

At startup, discovery runs in the background. A connected server's `notifications/tools/list_changed` updates
its contribution without a client command. Configuration changes require `/reload-plugins`.

On explicit reload the server validates the entire file, opens the proposed enabled servers, discovers their tools,
and validates their combined extension contribution before replacing the active configuration. A malformed or
unreadable file, invalid entry, failed connection/discovery, or conflicting contribution leaves the previous MCP
configuration in use and is reported to the client. Only a missing file means no configured servers; `{ "mcpServers":
{} }` explicitly removes them too. Fix a failed server and reload to retry.

**Reload reconnects MCP sessions**, even if their command or URL is unchanged, so changed stdio implementations can
be picked up. A stateful MCP server may therefore lose process/session-local handles. Requests already executing
finish on their old connection, which closes when they settle. Reload does not promise to retain old remote session
state, and already-dispatched tool calls are not retried on a different connection.

The code-mode sandbox itself stays alive: changing MCP namespaces does not discard a running script. Subsequent
nested tool calls resolve according to Durable's own phase/registry semantics, not an app-owned script-wide snapshot.

## Extension ownership

`packages/infinichat-server/src/registry.ts` defines the Chord `infinichat.extensions` registry. Host-lifetime plugin
objects contribute with `self.register(Extensions, ...)`. Ordinary values are Durable `Extension` objects.

For tools discovered asynchronously, the same registry also accepts a small application `ExtensionSource` adapter:

- `extensions()` returns fresh extension objects for the current state;
- `subscribe(listener)` reports changes between code reloads;
- `reload(validate)` prepares a configuration refresh, calls `validate(candidateExtensions)` before publishing,
  and returns a human-readable result; rejection must leave its current configuration intact.

This adapter is the application's registry reader, not an additional Pi SDK extension API. It is needed because
Chord's registration table changes on code commits, while MCP tool discovery can change afterward. The reader
subscribes to the current sources and publishes a complete immutable Durable snapshot. Duplicate extension owners
are rejected; a built-in live contribution cannot silently overwrite a user plugin after the table has been read.

The built-in facet registers the MCP/code-mode source just like the other extensions. Its source functions are
recreated when the facet reloads. Only native resources and data are retained: the sandbox, current connections,
and listeners. Durable extension names remain `mcp`, `codemode`, and `tool-search` as supplied by their factories.
The Harness and its registry reader stay open, so existing conversations and subagents see future publications.

The host owns clients, including clients still connecting or draining; individual operations only borrow a shared
client. Canceling one operation does not close another's client. Retired callbacks cannot publish into the current
server set. Shutdown closes conversation work first, then every remaining MCP connection and the sandbox.

## Release

Only the server version and its generated manifest change for a server release. Run the server package's lint,
typecheck, build, and `check`, commit and push, then run `pnpm release` there. It produces the runtime tarball,
`infinichat.js`, and the hash-bearing `release.json`. `--latest=false` is intentional: GitHub Latest belongs to the
Mac app, not the server. The release script supports GNU tar on Linux and BSD tar on macOS.

A server installed from a release checks at startup, daily, and on SIGHUP. It verifies downloaded artifacts, closes
its Harness and exits 75 for the service manager to restart it. Verify the live advertised version and service,
not only the downloaded manifest. Old runtime folders are cleaned on startup; keep recovery assets separately.
