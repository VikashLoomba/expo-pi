# Extending InfiniChat on a machine

For InfiniChat's agents, and for people. A machine's InfiniChat server loads the plugins of `~/.infinichat/plugins`
and connects the MCP servers of `~/.infinichat/mcp.json`. Both are the user's: a release never touches them. Use an
MCP server when one exists for the job, which needs no code, and a plugin for a tool of your own, a prompt section or
a hook. Paths starting with `../` are relative to this file's folder, inside the server's runtime.

## Change, reload, read the reply

1. Write the files on the device holding the chat, the default of the shell, read, write and edit tools.
2. Reload. An agent calls its tool from a script, `return await tools.reload_plugins();`. A person types
   `/reload-plugins` in the app. Both run the same reload, which builds the plugins whose files changed and applies
   `mcp.json` again. The conversation goes on, and servers left unchanged stay connected.
3. Read the reply, fix what failed, and reload again:
   - `Plugins: added a; reloaded b; removed c.`, or `nothing changed`.
   - `Plugin a failed: ...` with the build or load error. A new plugin that fails is left out; a changed one keeps
     the code it had.
   - `Plugin folder a: ...` for a folder that is no plugin, such as one without a `package.json`.
   - `MCP: connected a (3 tools); reconnected b (1 tool); closed c; failed d; unchanged e.`, then why each failed
     and which entries were skipped.
4. Tools a reload added are callable from the next script, not from the one that reloaded: a script has the tools
   that existed when it started.

## A plugin

A folder of `~/.infinichat/plugins` with a `package.json`, whose `name` is the plugin's (an npm package name), and a
`server.ts` (or `.tsx`, `.js`, `.mjs`) whose default export is a Chord facet. The facet contributes pi-durable
extensions to the server's registry:

```json
{ "name": "hello" }
```

```ts
// ~/.infinichat/plugins/hello/server.ts
import { defineFacet, defineRegistry } from '@earendil-works/chord';
import { defineExtension, defineTool, type Extension, type RegistrySnapshot } from '@earendil-works/pi-durable';
import { obj, str } from '@earendil-works/pi-schema';

// A token of this name and version is the server's registry of extensions.
const Extensions = defineRegistry<readonly Extension[], RegistrySnapshot>('infinichat.extensions', { version: 1 });

const hello = defineTool({
  name: 'hello',
  description: 'Greet someone by name.',
  parameters: obj({ name: str({ description: 'Who to greet' }) }),
  replay: 'safe',
  execute: async ({ name }) => ({ output: [{ type: 'text', text: `Hello, ${name}!` }] }),
});

export default defineFacet((_host, self) => {
  self.contribute(Extensions, [defineExtension({ name: 'hello', tools: [hello] })]);
});
```

The server builds the facet into one script with esbuild, without a type check, and loads it into its own process.

**Imports.** A plugin imports its own files, Node's builtins (`node:fs/promises`, `node:child_process`), and the
server's own instances of `@earendil-works/chord`, `@earendil-works/chord/context`, `@earendil-works/chord/json`,
`@earendil-works/pi-ai`, `@earendil-works/pi-durable` and `@earendil-works/pi-schema`. Any other package goes into
the `dependencies` of its `package.json` and is installed in its folder (`npm install --omit=dev --ignore-scripts`);
the build inlines it. `import.meta`, `__dirname`, a dynamic `import()` and top-level `await` are refused.

**Extensions.** One brings `tools`, `sections`, `hooks`, `wraps` and `tasks`. Their reference is pi-durable's README,
`../node_modules/@earendil-works/pi-durable/README.md` ("Extensions", "Tools", "System Prompt"), with the types beside
it in `dist/`, and pi-schema's README for parameters. Chord's rules for plugins are in
`../node_modules/@earendil-works/chord/docs/plugin-authoring.md`; where it has a plugin import the app's API
(`@acme/app/v3`), InfiniChat has none, and a plugin imports the packages above, Chord among them.

**Rules.**

- A facet only declares, synchronously, and its module does no work when it loads. A plugin runs inside the server
  with the account's rights: one that throws while loading is left out, but one that blocks or loops there stops the
  server, and only the user can then remove it, over SSH, and restart the service.
- Give each extension and tool a name of its own, a tool's in `snake_case`. A tool named as an existing one can
  replace it, and of two extensions of one name only one is installed.
- The model is offered only code mode, whose scripts call every tool as `tools.<name>(args)`. A tool is declared in
  the prompt, within 3,000 tokens it shares with InfiniChat's own tools, which take most of them; past that the
  largest declarations are left out. So keep a description short, and give a tool that is seldom needed
  `deferred: true`: the prompt leaves it out, and scripts still call it by name and find it with `searchTools()`.
- `replay: 'safe'` on a tool lets a call that a restart cut off run again. Leave it out when a second run would do
  harm.
- A tool's `execute(args, api, context)` stops its work when `context.abortSignal` aborts.
- A section's text is the same at every request, or the provider's prompt cache is lost each time.
- A single file `~/.infinichat/plugins/<name>.server.ts` is a plugin too, but it imports only the server's packages:
  no builtins and no dependencies.

Removing a plugin is deleting its folder and reloading.

## An MCP server

`~/.infinichat/mcp.json` has an `mcpServers` object, in the format of pi's coding agent. Add an entry and keep the
others: `cua-driver`, which the server adds itself, is the machine's computer use.

```json
{
  "mcpServers": {
    "example": { "command": "node", "args": ["/path/to/server.mjs"], "env": { "TOKEN": "${EXAMPLE_TOKEN}" } },
    "docs": { "url": "https://example.com/mcp", "description": "The product's documentation" }
  }
}
```

- A name has only letters, digits, `_` and `-`, and differs from the others in more than `-` and `_`.
- A stdio server has `command`, and optionally `args`, `env` and `cwd`; a leading `~/` in them is the account's home.
  A streamable HTTP server has `url`, and optionally `headers` and `oauth`. SSE is not supported.
- Both take `enabled`, `description`, `timeout` (seconds per request, 60 by default), `exposure` and `toolExposure`.
  Every agent's prompt names the server as `mcp__<server>` with the first line of `description`, or else of the
  instructions the server sends: write one line that says what the server is for.
- `${NAME}` in `env`, `headers` and `oauth.clientSecret` expands from the server process's environment, which a
  service gets when it starts. A name it lacks skips the server, and the reply names it. A secret can instead be
  written into the file, which stays readable by the account alone (`chmod 600`).
- `exposure` says how the server's tools reach the prompt. `codemode`, the default, and `deferred` leave them out of
  it: scripts find them with `searchTools('...', { namespace: 'mcp__<server>' })` and call them as
  `tools.mcp__<server>__<tool>(args)`. `direct` declares them in the prompt, within the 3,000 tokens above. `hidden`
  does not register them. `toolExposure` sets it per tool, `{ "search": "direct", "admin_*": "hidden" }`: an exact
  name wins over a `*` pattern, and the first pattern that matches wins.
- An HTTP server without an `Authorization` header that answers 401 signs in with OAuth. It fails as *needs sign-in*
  until the user types `/mcp` in the app and signs in there; an agent cannot. `oauth` takes `clientId`,
  `clientSecret`, `callbackPort`, `callbackUrl`, `scope`, `clientName` and `authServerMetadataUrl`; without a
  `clientId` the server registers itself as InfiniChat.
- While a connected server offers resources, scripts also have `list_mcp_resources`,
  `list_mcp_resource_templates` and `read_mcp_resource`.

A server's stderr tail and its state are in the app's `/mcp`, and the log messages it sends in
`~/.infinichat/mcp.log`. A malformed `mcp.json` configures no server, so every server closes, and the reply says
why: fix it and reload.
Removing a server is deleting its entry, or setting `"enabled": false`, and reloading.

## What stays as it is

- InfiniChat's own plugin and its tools plugin (code mode and the MCP client) change only with a release.
- The rest of `~/.infinichat` is the server's: the conversation in `data`, `credentials.json`, `mcp-auth.json` and
  `server`. Never edit them.
- Restarting the service is the user's to do. On Linux its log is `journalctl --user-unit infinichat.service`.
