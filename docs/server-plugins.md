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

Before it resumes, the server offers the model code mode, as Durable's README shows it ("Who may call a tool",
`modelTools`), and `tell` and `spawn` beside it: every agent of the tree writes scripts, which call InfiniChat's
tools, the MCP tools and plugins' tools, and says what it has to say, and starts a child, in calls of its own, which
the screens show as its messages (`callers: ['model']`, so no script makes them). A conversation held by the phone, which has no code mode, offers every tool again
(`OptChat.offer`). Without a registered `codemode` tool the server offers every tool too.

## The user's plugins

A plugin is a folder of `~/.infinichat/plugins` with a `package.json`, whose `name` is the plugin's (an npm package
name), and a `server.ts` (or `.tsx`, `.js`, `.mjs`) whose default export is a facet; or a single file
`<name>.server.ts` there. The guide a release ships, `packages/infinichat-server/docs/extending.md`, is the
reference for writing one, with an example. A folder without a `package.json` is reported and not loaded. Chord's
plugins component
(`createPlugins`, `src/plugins.ts`) finds them, builds each facet into one script with esbuild (the plugin's own
files and the packages of its `dependencies` inlined), evaluates it and loads it beside the runtime's facets. A
plugin that fails to build or load is left out, and the others load.

A plugin imports the server's own instances of these packages, and nothing else from the runtime:
`@earendil-works/chord`, `@earendil-works/chord/context`, `@earendil-works/chord/json`, `@earendil-works/pi-ai`,
`@earendil-works/pi-durable` and `@earendil-works/pi-schema` (`MODULES` in `src/plugins.ts`). The server defines no
API package of its own, so Chord takes an import of Chord itself (its `docs/plugin-authoring.md` refuses one only
under an app's API). A facet only declares (design §16), and contributes its Durable extensions to the registry by a
token of the registry's name and version, `infinichat.extensions` at 1, as the guide's example does.

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

## The agents extend the server

On a machine, an agent writes a plugin or adds an MCP server when the user asks, as pi's coding agent extends pi: its
prompt names pi's documentation on disk, which the model reads when asked (`promptSections.docs` in the coding
agent's `src/core/system-prompt.ts`). InfiniChat's plugin contributes one extension for it, `infinichat.extending`
(`src/extending.ts`), which every agent on the machine has, a child of the tree too, and a conversation the phone
holds has not:

- A prompt section, `extending`: the plugins folder, the MCP configuration, the guide's path and the tool below, to
  use when the user asks for a tool or a server. Its text changes only with the runtime's folder, so it is sent once
  and stays cached (durable `test/examples/14-system-prompt.ts`).
- The guide, `packages/infinichat-server/docs/extending.md`, which the build copies to `dist/docs` and a release
  ships in the runtime, `<runtime>/docs/extending.md`. It is the reference for the plugin layout and for `mcp.json`,
  for people too, and points to what the runtime's `node_modules` already holds for the rest: Chord's
  `docs/plugin-authoring.md` and pi-durable's README.
- A tool, `reload_plugins`, the agents' `/reload-plugins`: the process's one reload, whose reply the agent reads and
  acts on. pi's own tools cannot reload (coding-agent `docs/extensions.md`, "ctx.reload()"); that the agent applies
  its own change is the owner's decision. It is deferred, so code mode's section leaves it out and the `extending`
  section names it. An aborted call stops waiting, and the reload goes on. A script has the tools that existed when
  it started (durable `src/codemode/codemode.ts`, `execute`), so the tools a reload adds are callable from the next
  script.

A plugin runs inside the server's process: one that blocks while it loads stops the server, and the user removes it
over SSH, as with an extension of pi. The guide has the agent keep a facet to declarations.

Checked by lint, typecheck (the guide's example too) and build. Not run: an agent has not yet extended a server
with it.

## MCP configuration

`~/.infinichat/mcp.json` has an `mcpServers` object in the format of pi's coding agent. The guide describes it, with
an example: a stdio and a streamable HTTP server's fields, `${NAME}` from the server process's environment, exposure
and OAuth (`packages/infinichat-server/docs/extending.md`, "An MCP server"). `src/mcp-config.ts` reads it. A
request's `timeout` is renewed by the server's progress notifications. Legacy SSE is not implemented.

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

## Computer use: Cua Driver

The agents see and operate desktop apps on a machine through Cua Driver (github.com/trycua/cua, read at commit
`066c9d1`, driver 0.47.6, and for Linux without a screen at `bff492d`), which Cua ships as one program that serves MCP
over stdio (`cua-driver mcp`). The tools plugin's object has it installed (`src/cua-driver.ts`) at its start and
before each `/reload-plugins` reads `mcp.json`, when the account has no `~/.local/bin/cua-driver`:

- It runs Cua's install line (README "Cua Driver") with the installer's own switches `CUA_DRIVER_NO_CONNECT`,
  `CUA_DRIVER_NO_TEST` and `CUA_DRIVER_NO_MODIFY_PATH`, so the account's Claude Code, Codex and Cursor, its shell
  profile and its screen stay as they are, then turns Cua's telemetry off for good (`cua-driver telemetry disable`;
  the installer sends no install event either).
- After a successful install it adds the server `cua-driver` to `mcp.json`, unless the file has one of that name, and
  applies the file. The entry is the user's from then on: the driver is installed, so an entry removed or set
  `"enabled": false` stays so. A failed install is in the service's log, or in the reload's reply, and the next start or
  reload tries again.
- The entry runs `~/.local/bin/cua-driver mcp`, the link Cua's updates keep (`cua-driver mcp-config` prints the folder
  of one version), on Linux inside a desktop of its own (below). The driver has 66 tools, which keep the default
  exposure and which scripts find with `searchTools()`, except its guide:
  `"toolExposure": { "get_guide": "direct" }`. Code mode's prompt section leaves
  out the tools of the default exposure, and a server with no tool declared there gets no heading, so without this
  the model learns of a server only by searching. With it the section names `mcp__cua-driver` with Cua's own one-line
  description and declares `get_guide`, about 240 tokens, and the guide tells of the rest. The section's 3,000-token
  budget is shared with InfiniChat's own tools, which the driver's larger tools would crowd out.
- On macOS the driver's process hands over to Cua's app (`/Applications/CuaDriver.app`), which the system's
  Accessibility and Screen Recording permissions belong to. The server does nothing about them: Cua asks.

Cua's installer, updater (`cua-driver update --apply`) and uninstaller own the driver's files; the server never updates
or removes it. The object's native ends an install under way when the host closes, and Cua's installer swaps a version
into place atomically, so the next start installs again. The driver's process is the MCP connection's, as any stdio
server's. Cua's installer and uninstaller end every `cua-driver` of the account (`pkill -x cua-driver`), a running
server's too, so neither is run by hand, even into a scratch home, on a machine whose server should keep its driver.

### Linux: a desktop of its own

On Linux the driver works in a virtual desktop, always: a machine needs no monitor and no login, and the agents never
take a real session's pointer or see its windows. A real X session is no substitute on a machine used without a
screen: with every output disconnected its compositor stops drawing, and each capture returns the last frame. The
entry's command is `sh -c` with this script (`DESKTOP` in `src/cua-driver.ts`):

```sh
exec 3>&1 >&2
unset WAYLAND_DISPLAY SESSION_MANAGER NO_AT_BRIDGE
export XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR/infinichat-desktop"
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
export GTK_MODULES=gail:atk-bridge GNOME_ACCESSIBILITY=1 QT_ACCESSIBILITY=1 QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export MOZ_ENABLE_ACCESSIBILITY=1 ACCESSIBILITY_ENABLED=1
exec xvfb-run -a -s '-screen 0 1280x800x24 -dpi 96 +extension RANDR +extension GLX -noreset' \
  dbus-run-session -- sh -c 'xfwm4 3>&- & exec "$HOME/.local/bin/cua-driver" mcp >&3 3>&-'
```

- It is how Cua runs the driver headless: "wrap this command in xvfb-run and dbus-run-session"
  (`scripts/ci/linux/run-rust-e2e.sh`). The display's size and options and the accessibility variables are those of
  Cua's desktop image (`libs/images/common/desktop/start-desktop.sh`), and `xfwm4` is the window manager of XFCE, the
  desktop Cua validates on (`Skills/cua-driver/LINUX.md`).
- Only the driver may write to the MCP stream. xvfb-run joins its command's stderr to stdout, and the session's
  services inherit stdout (the accessibility registry prints a line there), so stdout is kept as descriptor 3 for the
  driver and everything else writes to stderr, whose tail `/mcp` shows.
- The service can have a real session's environment: the account's service manager takes it in at a login, and this
  machine's service has `DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `SESSION_MANAGER` from its Cinnamon
  session. xvfb-run and dbus-run-session replace the first three. `SESSION_MANAGER` and `NO_AT_BRIDGE` are unset as
  Cua's image unsets them: with the first, the desktop's apps would sign on to the real session's manager, which
  ends its clients at a logout. `WAYLAND_DISPLAY` is unset so that an app does not open in a Wayland session; that
  is reasoned, not checked on a Wayland machine.
- The session has a runtime folder of its own, as Cua's image has: it mounts gvfs and starts dconf and an accessibility
  bus there, which would otherwise be the real session's.
- The MCP connection owns the desktop. pi-mcp starts the command in its own process group and ends the group when
  the connection closes (`StdioTransport`), and the apps the driver starts are its children in that group. Nothing in
  the desktop could outlive the driver, so the display is the driver's too, and no part of it is the server's to
  start, watch or stop. The desktop lasts until the server stops or restarts, the entry changes or is turned off, or
  the user reconnects the server in `/mcp`, which gives a fresh one; a reload with the entry unchanged leaves it. A
  closed connection leaves no process, socket, lock or mount; a group ended without that close leaves xvfb-run's
  folder with one small file in `/tmp`.
- A machine without `xvfb-run`, `dbus-run-session` or `xfwm4` gets no driver: the install fails with what is missing
  (Debian and Ubuntu: `xvfb`, `dbus-daemon`, `xfwm4`; the apps' accessibility is `at-spi2-core`), in the log and in
  the reload's reply, and the next start or reload tries again. The server installs nothing with root.
- Under a virtual display the driver has no background pointer for a surface without accessibility, a browser's page
  for one, and Cua's guide has the model ask for `delivery_mode: "foreground"` there, which in this desktop disturbs
  nobody (`Skills/cua-driver/LINUX.md`). A second copy of an app that also runs in the real session shares its home
  folder: a browser may hand a new window to the copy already running there.
- To have the agents work on the real session instead, the entry is the user's to change, to
  `"command": "~/.local/bin/cua-driver", "args": ["mcp"], "env": { "DISPLAY": ":0" }`.
- Checked on Linux Mint (X11) with driver 0.47.7: in scratch runs through pi-mcp's `McpClient` and `StdioTransport`
  (launch, the accessibility tree, an element click, typing and a pixel click on a GTK dialog; a close that leaves
  nothing), and on a live server, where a `/reload-plugins` moved the connection to the desktop and an agent's turn
  captured it. Not run: the newest driver (0.52.9 when this was written), a browser, drags and scrolling.

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

A machine offers Claude twice: through its Claude Code login (`src/claude-code.ts`), and with an Anthropic API key,
pi-ai's Anthropic provider as every device registers it (`chat-providers.ts`). The Providers screens list each as its
own section. A conversation that has no models yet takes those of the first connected provider, OpenAI before the
others and then in the catalog's order, so with both connected and no OpenAI it starts on the API key.

The first is pi-claude-code's provider (github.com/earendil-works/pi-claude-code, pinned to a commit in
`package.json`; it is not on npm), registered as its own extension entry registers it; it names itself "Claude Code
Subscription (Experimental)". The phone and the Mac app's own chats have only the API-key provider: Claude Code's
drives the `claude` program, which only a machine has. Claude Code keeps the login (`claude auth login` in the
machine's terminal), so the credential store has nothing for it: the Providers screens show what pi-ai's availability
check finds (`claude auth status`), read at the server's start and at each refresh of models. `claude` must be on the
PATH of the account's login shell, which starts the server. The provider starts a `claude` process for a
conversation's requests and keeps at most two warm for five minutes; the server ends them as it closes. The build
copies the script the provider runs as its tool inventory, `inert-mcp.mjs`, beside InfiniChat's plugin, and a release
ships it in the runtime.

## Contract versions

`infinichat.remote` and `infinichat.mcp` (`packages/infinichat/src/pi/infinichat-remote/contract.ts` and
`mcp-contract.ts`) are what an app and a server bind by: a hold carries the app's version of the contract and its
fingerprint, and binds only to a server that serves that version (design §5, "Compatibility"). They change as Chord's
design has a contract change (§27, "Contract evolution in code"; `docs/layer-1.md`, "Evolution"):

- The oldest version still served is the history's base, a `remote()` written in full. It stays as it was released,
  and so do the schemas it names: Chord computes a version's fingerprint from them, so an edit to one changes the
  fingerprint of every version that has it and locks out the apps built with those. A schema that has to change gets
  a new definition, which the next version takes. The schemas pi's packages supply count too
  (`ModelThinkingLevelSchema` in a chat's model settings): a pi upgrade that changes one is a contract change.
- Each later version is `evolve(previous, edits)`, one version per release that changes the contract, an added
  member included.
- The server serves the older versions with `accepts` on `host.serve` (`ACCEPTED` in `src/facet.ts`): for each
  member a later edit changed or removed, a mapping of the old arguments to the new, or of the new state or result
  to the old; an added member needs none. TypeScript requires exactly those mappings, and Chord checks the table
  against the history when the plugin loads.
- So an app works with every server released after it. The other direction has no mapping: an app newer than the
  server waits with `contract_mismatch`, and asks that server to update itself when a newer release of it is
  published (`RemoteInfiniChat`). The server is still released before the apps that need it.
- Dropping a version from `ACCEPTED`, or a new base (a change of params or of the variant set is one), refuses the
  apps on the versions left out, which are told to update. That is the owner's decision.

`infinichat.remote` is at version 10 over the base 8, which server 4.1.0 released: 10 is the tree of agents, and
the versions before it are served root's chat as the one chat, with no tree. `infinichat.agent`, one agent's chat by
its name, which server 5.0.0 added, and `infinichat.mcp` are at their bases, version 1. The Mac app's own contracts (`apps/mac/src/contract.ts`) are between its main process and its window, one
build, so they have no older version to serve.

## Release

The tools plugin is part of the runtime's `main.js`. The runtime tarball also holds
`plugins/infinichat/inert-mcp.mjs` and the agents' guide, `docs/extending.md`, and the runtime key hashes
`package-lock.json`, `main.js` and those two, so a server whose runtime differs downloads the new one and restarts
into it. `main.js` holds no version: the runtime
reads its release's from InfiniChat's plugin, which exports it (`version` in `src/facet.ts`), so a release that
changes only the plugin keeps the runtime key, and a server on that runtime downloads the plugin alone and replaces
it in place. `release.json` keeps its schema (`version`,
`runtime.key`/`sha256`, `plugin.sha256`). Run the server package's lint, typecheck, build and `check`, commit and
push, then run `pnpm release` there. `--latest=false` is intentional: GitHub Latest belongs to the Mac app, not the
server.

An app holds no server release, and nothing compares an app's with a server's. Chord binds an app and a server by
their contracts' versions, and pi-durable versions what a conversation stores (above, and Durable `docs/spec.md`
§3.6); a release number says neither. What an app does compare is a server's release with the newest one published
(`behindNewest`, `infinichat-remote/release.ts`), which it reads from this repository's releases as an install does:

- A connected server behind the newest release is offered its update: the connection says so
  (`RemoteConnection.update`), and the iPhone's chat screen shows a notice with Update above the input, which asks
  the server to update itself (`requestUpdate`, SIGHUP). The server takes the newest release, restarts, and the app
  connects again. So a release that changes only the server shows in the apps already installed.
- A server whose contract does not fit the app is asked to update itself when it is behind the newest release. One
  that is on it no longer serves the app's version, and the app says to update the app.
- A machine about to take the conversation in a move is asked to update first when it is behind the newest release
  (`move.ts`, `receives`). A move back to a device checks nothing: pi-durable refuses what an older app cannot read
  when the app opens it, which the app reports as its failure to open, with the files there and unopened.

Releases that cannot be read offer no update, and the server still finds its own. Release the server before the apps
that need it.

A server installed from a release checks at startup, daily, and on SIGHUP. It verifies downloaded artifacts, closes
its Harness and exits 75 for the service manager to restart it. Old runtime folders are cleaned on startup.

pi-durable migrates documents and tasks one way: once a newer release has opened the conversation, an older one
refuses it (Durable `docs/spec.md` §3.6, §11.2). So before a release first opens the database another release left,
the server copies it to `~/.infinichat/backup/before-<release>/infinichat.db` with SQLite's online backup, replacing
the copy the previous update made; `state.json`'s `opened` records the release that last opened it. To go back,
install the release that left the copy and put it in `~/.infinichat/data/` while the server is stopped.
