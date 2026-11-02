# Server plugins, MCP and code mode

The server uses Pi Durable / Chord **1.5.0**, upstream tag `v1.5.0`, commit
`f9a26365568127461c47a07a37dcb42c140a3ac5`. The starting patterns are Chord's `packages/chord/docs/guide.md`
sections **Plugins**, **Declarations**, **Hot reload** (Resources) and **Durable**, and Durable's README sections
**Extensions**, **Reload** and **Code Mode** with `docs/spec.md` §7.4–7.5.

## What the server loads

The Chord host (`main.js`) loads, in order: InfiniChat's plugin (`plugins/infinichat/server.js`, `src/facet.ts`), the
tools plugin (`plugins/tools/server.js`, `src/tools-facet.ts`: code mode and MCP), and the user's plugins, each a
folder of `~/.infinichat/plugins` with a `server.ts`, `server.mts`, `server.js` or `server.mjs` facet.

## Reload from a client

`/reload-plugins` from the Mac or iOS client reloads the tools plugin and the user's plugins in one Chord reload,
removes plugins whose folder is gone, then loads new folders. InfiniChat's own plugin is not reloaded: only a release
changes it, and a release restarts the server. The conversation, its Harness and the clients' links stay as they are.
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
`${NAME}` in `env` and `headers` values expands from the server process's environment; a name it lacks skips that
server, and the reply names the variable. A leading `~/` in command, arguments, or working directory expands to the
account's home. Common fields are `enabled`, `description`, `timeout` (seconds per MCP request; default 60), and
`exposure`. OAuth and legacy SSE are not implemented.

Exposure: `direct` tools are offered to the model; `codemode` (default, including its `codemode-deferred` alias) and
`deferred` tools are callable through code mode but omitted from its inline prompt declarations. A `deferred` server
also enables Durable's `tool_search`, which can load deferred tools for direct model calls. `hidden` tools are not
registered. This is not a separate per-server authorization boundary.

## How a reload treats servers

The tools plugin's object reads `mcp.json` on every run and declares the code-mode sandbox and one Chord resource per
enabled server, named `mcp__<server>`, whose version is a hash of its resolved connection (command, args, env and
cwd, or url and headers, and timeout). Chord keeps a resource whose version is unchanged, opens a changed one beside
the old one, and closes one no longer declared. So a reload connects added servers, reconnects changed ones, closes
removed or disabled ones, and leaves the others connected; a change of only `exposure` or `description` republishes
the tools without reconnecting. A server left unchanged that isn't connected, for example one that was down, is
tried again.

A server connects and lists its tools in the background, so one that fails never fails the start or the reload; the
reply and the server's log report it. A dropped connection reconnects at the next call, and
`notifications/tools/list_changed` republishes the tools without a reload. A malformed or unreadable `mcp.json` is
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
