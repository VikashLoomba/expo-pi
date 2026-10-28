# Piece 2: InfiniChat on this Mac

## Goal

The window shows the conversation held by this Mac's server and sends to it: the Mac is a client of its own
LaunchAgent server, which it installs and updates itself, with the package's client objects unchanged.

## What upstream does

- **The dialer and the install:** `apps/mobile/src/pi/infinichat-remote/phone-dialer.ts:59-114` is the pattern: read
  the saved secret (`savedSecret`, `install.ts:81`), check for a live server of this bundle (`runningServer`,
  `install.ts:388`), else install (`machineSecret` then `installServer`, `install.ts:95, 269`, which writes this
  client's file to `~/.infinichat/clients/<client ID>`, `:347-349`, and starts the LaunchAgent, `:188`), then a
  WebSocket to the port with `authorization: Bearer <secret>`, wrapped by `webSocketLink`. The server side is
  `apps/mobile/server/listen.ts`. On this Mac there is no SSH and no tunnel: the environment is
  `new NodeExecutionEnv({ cwd: homedir() })` (`node/devices.ts:21`), and `ws`'s client `WebSocket` takes `headers`.
- **The client objects:** `RemoteInfiniChat(dialer, directory, client)` (`client.ts:51`) owns dial, reconnect,
  reinstall on a bundle mismatch (`:377-379`), `setTimeZone` and `setMachines` at connect; `ShownInfiniChat`
  (`apps/mobile/src/chat/shown-infinichat.ts:24`) is what screens read across moves. The phone wires them at
  `chat-provider.tsx:136-146, 148-152, 227-234`.
- **Serving a shown host:** `apps/mobile/server/serve.ts:40-112`: cells with `{ init }`, `self.on(name, store, …)`
  mirrors with `replace(ctx, value, { diff: true })`, the snapshot last.
- **Assets:** `ServerAssets` (`install.ts:27-34`) and the phone's loaders (`server-assets.ts:34`,
  `daemon-assets.ts:37`) verify bytes against the generated manifests. On the Mac the files sit in the bundle's
  `Resources`, found with `PATHS.RESOURCES_FOLDER`; `build.copy` places them (deviation 3 decides where they come from).

## Builds

- `src/main/identity.ts`: `macClient(): InfiniChatClient` from `userData/settings.json` (`clientId`, made once with
  `randomUUID`) and the computer name (`scutil --get ComputerName`, read once; `os.hostname()` without `.local` if it
  fails). `src/main/home.ts`: `InfiniChatHomeStorage` over `userData/infinichat-home.json` with `readFileSync` and an
  atomic `writeFileSync` + `renameSync`. `src/main/secrets.ts`: `fileCredentialBackend(userData/credentials.json)`
  (`node/credentials.ts:25`), the one store for the Mac's machine secrets and, later, its provider credentials.
- `src/main/server-assets.ts`: `macServerAssets` reading `Resources/server/server.bin` and
  `Resources/server/pi-env-<target>.bin`, checked against `INFINICHAT_SERVER_MANIFEST` and `PI_DAEMON_MANIFEST`;
  `SERVER_BUNDLE = serverBundle(manifest.sha256)`.
- `src/main/dialer.ts`: `macDialer(machines, machineId)`. For the Mac itself: environment = local `NodeExecutionEnv`,
  `username = os.userInfo().username`, name = the computer name, description = `machineDescription`; the dial, install,
  `open`, `reinstall` and `close` as the phone's, the socket `new WebSocket(url, { headers })` from `ws`, closed
  socket → `onDropped`. Other machines come in piece 5 through the same function.
- `src/main/infinichat.ts`: the InfiniChat part of the phone's runtime: `ShownInfiniChat`, `remotes` per machine,
  `machine(id)`, `showMachine`, `open()` at launch. Until piece 4 the only machine is this Mac, with a directory
  whose `others()` is empty. With no home record the Mac starts on its own server; a server that is not `active`
  shows where the conversation went (`conversation.heldBy`, piece 7 of docs/infinichat-package): "InfiniChat is on
  <phone>. Move it here from the phone."
- `src/contract.ts`: `MacInfiniChat` (`hostNamed('mac')`, input `{}`): cells `snapshot`, `controls`, `messages`,
  `scheduled` (the remote contract's schemas, imported), `connection` (`RemoteConnection`: status, stage, error,
  notice), `held` (`ConversationSchema`), `machine` (`{ id, name }`); methods `accept({ content, requestId })`, `stop`,
  `dismissError`, `dismissNotice`, `reconnect`.
- `src/main/serve-infinichat.ts`: `host.serve(MacInfiniChat, …)` over `ShownInfiniChat` and the shown client's
  `getConnection`/`getHeld`; the phone's `useInfiniChatView`, `useInfiniChatConnection` and `useInfiniChatError`
  (`chat-provider.tsx:484-569`) become these cells.
- `src/view/infinichat.tsx`: the screen: title (the agent's name or InfiniChat), subtitle (connected, connecting with
  its stage, failed with Try Again), the transcript as plain rows (user and assistant text, the working footer
  `transcript.tsx:101-102`), the composer (a growing textarea, Enter sends, Shift+Enter breaks, Send and Stop), the
  banners (`(infinichat)/index.tsx:256-276` without the move ones): error with Try Again/Dismiss, install notice,
  "on <phone>". A send keeps its request ID across retries (`index.tsx:56-58, 136-155`).
- Deviation 2: `shown-infinichat.ts` moves to `packages/infinichat/src/pi/`; the phone imports it from there.

## Ownership and lifetime

`RemoteInfiniChat`s are made by `machine(id)` and closed by `closeMachine` or at quit, before the host closes (the
phone's teardown order, `chat-provider.tsx:258-278`). The LaunchAgent server belongs to launchd and is never stopped by
the app; an install replaces its bundle as the phone's does. The Mac's client file on the server is written by the
install and removed only by "Remove machine" (piece 4), never by quitting.

## Deviations

2 and 3.

## Size

About 750 lines: dialer 120, assets 60, identity, home and secrets 60, composition 120, contract 60, serve 80, screen
250.

## Checks

- First launch on this Mac with the phone's server already installed here: the app reuses it (same bundle), writes
  `~/.infinichat/clients/<mac id>`, and shows the conversation or "on <phone>"; the phone stays connected.
- Without a server: the app installs the LaunchAgent (`launchctl list | grep piagent`), waits for `server.json`, and
  connects. A stale bundle is reinstalled; the notice shows once.
- A turn sent from the Mac appears on the phone within the same session, and the other way round.
- `launchctl kickstart -k` the server: the subtitle shows failed, Try Again reconnects. Quit and relaunch reconnect.
- Lint, typecheck, dev build; the phone's gates since the package changed.

## Not in this piece

Markdown and tool rendering (3), other machines and moves (4, 5), settings, providers, tasks (6).

## As built

From `be59fc7` on `feat/mac-app-shell` (2026-10-28), pi 1.4.0 (still the latest on npm), two commits. What differs
from the plan:

- **The server package first (deviation 3).** `packages/infinichat-server` holds the former `apps/mobile/server`
  as `src/`, both scripts, both generated manifests (`manifest.ts`, `daemon-manifest.ts`) and `assets/` (the bundle
  and the four pi-env daemons); `exports` are `./*` → `src/*.ts` and `./assets/*`. The phone requires the assets
  through the package (`require('@pi-agent/infinichat-server/assets/server.bin')`), which Metro resolves: an
  `expo export --dump-assetmap` lists all five `.bin` files at their new paths. `apps/mobile` lost `ws`, `@types/ws`
  and `esbuild`. The bundle's hash changed to `ea05156e…`, since esbuild's comment paths are relative to the new
  root, so **the phone needs a Release install** before it and the Mac connect to the same machine; until then each
  app reinstalls its own bundle there. Today they don't overlap: InfiniChat is on vikash-system, which the Mac reaches
  only from piece 5. The gates are `pnpm --filter @pi-agent/infinichat-server typecheck` and `… check`.
- **`shown-infinichat.ts` moved into the package** with relative imports (deviation 2); the phone imports it from
  `@pi-agent/infinichat/pi/shown-infinichat`.
- **The home record starts on this Mac's server.** The package's parser reads a missing record as "this device"
  (`home.ts:21`), which the app can never be, so `macHome` reads a missing file as
  `{ home: 'machine', machineId: 'mac', phase: 'there' }`. `THIS_MAC` and the one-record machine list live in
  `src/main/machines.ts`, which piece 4 grows.
- **The client ID lives in `settings.json`**, on the app's one `Settings` object, so a later frame write keeps it;
  the name is `scutil --get ComputerName`.
- **The composition is a class**, `MacInfiniChat` (`src/main/infinichat.ts`): the phone's `useChatRuntime` without
  the local side and the React state, plus one store for the current client's connection, machine and `conversation`
  cell, which `serve-infinichat.ts` mirrors with `self.on`. The contract object is `infinichat.mac.conversation`.
- **No `onDropped` for this Mac**: with no transport under the link, the link's own close is the only drop.

Verified on this Mac, which already ran the phone's server with an older bundle (`4ed0ba2e…`): at launch the app
found the mismatch, installed the new bundle to `~/.infinichat/server/ea05156e…`, restarted the LaunchAgent (a new
pid on a new port in `server.json`), wrote its client file beside the phone's in `~/.infinichat/clients/`, and kept
its secret as `pi.infinichat.secret.v1.mac` in the app's `credentials.json`; `lsof` shows the app's socket to the
server established, and `machines.json` gained the Mac's client ID with `[]`, which `RemoteInfiniChat` sends only
once its reference is live (`client.ts:383-384`). The window should show "InfiniChat is on vikash-system", since the
server's `conversation` cell says so; that, a sent turn and a reconnection after the server restarts are not verified
from this session, which can't see the screen, and need the conversation on this Mac.

**Found at the first move (2026-10-28):** the phone named this machine "Mac" and the Mac app named it by its
computer name, and `RemoteInfiniChat` reinstalls a server whose device or description differs from its dialer's
(`client.ts:421-423`), so the two apps reinstalled the server under each other at every connect and the phone's
readiness check lost the race ("could not be started"). The owner's rule: a machine names itself.
`machineIdentity` in `install.ts` reads the name and host name on the machine; both dialers install and expect the
server under them and build the description from the machine's host name; the phone keeps the name on its record
(`RemoteHostRepository.setName`) at Check connection and at each dial, and its form lost the Name field. The server
bundle is unchanged. The phone needed another Release install for it.
