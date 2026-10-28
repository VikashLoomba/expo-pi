# The Mac app

A macOS app that does what the iPhone app does: InfiniChat on whichever machine holds it, ordinary chats of its own,
providers, remote machines, moves, scheduled tasks. It is built with Electrobun 2.0.5: a Bun main process that owns the
app's state, and one WKWebView per window that draws the screens with React DOM. Nothing a phone user sees
changes.

Everything that runs anywhere already lives in `packages/infinichat`; its `src/node` subpath holds the Node
implementations of the seams "for the server and the Mac app" (`packages/infinichat/eslint.config.js:3`). The main
process composes those modules the way `apps/mobile/server/main.ts` composes them for a machine, and the way
`apps/mobile/src/chat/chat-provider.tsx:52-282` composes them for the phone. `apps/mac` adds the seams the package
leaves to each app, and the screens.

## Owner decisions (2026-10-27)

| Topic | Decision |
| --- | --- |
| Framework | Electrobun 2.0.5 (Hutch 0.28.2, Bun 1.4.4 main process, WKWebView). Electron was rejected as too heavy; Vercel Native can't run the packages. |
| The server on the Mac | The LaunchAgent server the phone installs, unchanged. The app installs and updates it on this Mac itself through `installServer` with a local `NodeExecutionEnv`, and is one more client of it over loopback, with its own client file in `~/.infinichat/clients/`. InfiniChat keeps running, reachable from the phone, while the app is closed. Needs Node 22.19+ on the Mac, as today. |
| Screens | React DOM in WKWebView, with streamdown for Markdown. Chosen over Warren DOM the same day: the phone's react-native-enriched-markdown streams through react-native-streamdown, and Vercel's streamdown is a React component, so the window is React. Warren's GPU renderer is experimental, has no text wrapping and needs Dawn bundled; `<electrobun-ui>` overlays can come later without changing anything here. |
| Releases | Signed and notarized from the first build; updates hosted on GitHub Releases of `VikashLoomba/expo-pi` (public). |
| Scope | Parity with the iPhone app before the owner uses it. Platform differences are listed below, not silently dropped. Only InfiniChat is shared through its server; each device keeps its own ordinary chats, as decided on 2026-10-26. |
| Identity | Name InfiniChat, identifier `com.vikashloomba.piagent.mac`; the LaunchAgent label `com.vikashloomba.piagent.infinichat` stays. |

Choices made by me and not objected to: the app is `apps/mac`; the main process is Bun (Electrobun's default);
`packageManager: "pnpm"` in `hutch.config.ts`; `titleBarStyle: "hiddenInset"`; design docs first, as for
`docs/infinichat-package`.

## How it runs

```text
  ┌──────────────── InfiniChat.app ───────────────────────────────────────────────────────┐
  │  main process (Bun 1.4.4)                              windows (WKWebView, React DOM)   │
  │  the phone's runtime, from packages/infinichat:        the phone's screens in HTML      │
  │   RemoteInfiniChat · ShownInfiniChat · InfiniChatMoves  one Chord client host per       │
  │   DurableChatService · ProviderCredentialStore          window, over a loopback          │
  │   installServer · keys · node/{credentials,devices,     WebSocket with a per-launch      │
  │   database-files,models} · pi-env connections           secret; refs through host.hold  │
  │  served as Chord objects (apps/mac/src/contract.ts)   ◄──────────────────────────────►  │
  └───────────┬──────────────────────────┬───────────────────────────────────────────────┘
              │ loopback ws + client secret │ ssh (pi-env) and an ssh -W tunnel per machine
  ┌───────────▼─────────────┐   ┌─────────▼──────────────────────┐
  │ ~/.infinichat LaunchAgent│   │ other machines' servers         │
  │ server on this Mac       │   │ (vikash-system, …)              │
  └──────────────────────────┘   └────────────────────────────────┘
```

- **The main process owns everything privileged**, as Electrobun's process model asks ("the main process owns
  application state and native objects; webviews render UI"): storage, SSH, secrets, Harnesses, native menus,
  notifications, the updater.
- **The screens are Chord clients of the main process only.** The main process serves its objects (InfiniChat as
  shown, the chats, the account, the machines) on a loopback `ws` server, the way `apps/mobile/server/serve.ts` serves
  the conversation to the phone, and each window connects with `webSocketLink(new WebSocket(...))`. A browser can't
  send the `Authorization` header the InfiniChat server checks, and splitting `RemoteInfiniChat` to route the machine's
  object through the main process (chord guide "Hosts and links": `host.route`) would complicate moves; mirroring the
  phone's own client objects into cells costs about as much as `serve.ts` and keeps the package untouched.
- **React reads Chord refs through one hook**: `useSyncExternalStore` over a ref member's `subscribe` and `value`,
  as the phone's hooks read their stores (`chat-provider.tsx:484-717`), so the phone's screens port with their hooks.
- **Electrobun's typed RPC carries only UI commands** from native events to a window (menu items, reopen). Everything
  else is a Chord call.

## The seams

| What it's for | Seam (package) | Mac implementation (`apps/mac/src/main/`) | Piece |
| --- | --- | --- | --- |
| Reaching this Mac's server | `ServerDialer` (`pi/infinichat-remote/dialer.ts:20`) | `macDialer`: `runningServer`/`installServer` through a local `NodeExecutionEnv`, then `ws` to `127.0.0.1:<port>` with the Bearer header | 2 |
| Reaching another machine's server | same | the same dialer over the machine's pi-env environment, tunnelled by the app's own `ssh -W` child | 5 |
| The server bundle and daemons an install uploads | `ServerAssets` (`install.ts:27-34`) | files in the app's Resources, verified against the generated manifests | 2 |
| This app as a client | `InfiniChatClient` (`contract.ts:50`) | `macClient`: a UUID kept in the app's settings file; the Mac's computer name | 2 |
| Where InfiniChat lives | `InfiniChatHomeStorage` (`home.ts:19`) | a JSON file under `Utils.paths.userData`, synchronous | 2 |
| The machine list | `MachineDirectory` (`dialer.ts:40`) | `MacMachines`: the app's list, pi-env targets, one connection per machine | 4 |
| Files and commands on a machine | pi-durable `ExecutionEnv` | pi-env `RemoteExecutionEnv` from `MacMachines`; `NodeExecutionEnv` for this Mac | 4, 5 |
| The local database's files | `DatabaseFiles` (`move.ts:78`) | none: the Mac never holds InfiniChat itself (deviation 1) | 5 |
| Secrets and sign-ins | `CredentialBackend` | `fileCredentialBackend` (`node/credentials.ts:25`) at `userData/credentials.json` | 8 |
| Chats' storage, images, environments | pi-durable `Storage`, `ImageProcessor`, `ExecutionEnv` | `openNodeSqliteStorage`, `createPhotonImages`, `NodeExecutionEnv` on a folder per chat (`node/devices.ts`) | 7 |
| Scheduled-task notifications | `ScheduledSource` the phone mirrors (`infinichat-scheduled.ts:25`) | timers in the main process and `Utils.showNotification` | 6 |

## Pieces

Implement in order; each leaves the app building, the phone app and the server untouched unless the piece says so.

| # | Piece | Builds | Rough size |
| --- | --- | --- | --- |
| 1 | [The shell](01-shell.md) | `apps/mac` on Hutch, the main window, menus, lifecycle, the loopback Chord host and the window's client, the layout and theme, the gates | ~450 lines + CSS |
| 2 | [InfiniChat on this Mac](02-infinichat-on-this-mac.md) | the client identity, the home record, the server assets, the dialer for this Mac, `RemoteInfiniChat` served to the window, a plain transcript and the composer | ~750 |
| 3 | [The transcript](03-transcript.md) | Markdown, thinking, work reports, tool cards, web search, images, copy, name and avatar, photo attachments | ~450 |
| 4 | [Machines](04-machines.md) | the Mac's machine list over pi-env, check connection, host keys, key exchange, the Settings window with its Machines pane | ~600 |
| 5 | [Moves](05-moves.md) | the dialer for other machines, `InfiniChatMoves` between machines, the machines menu, following `heldBy` | ~400 |
| 6 | [InfiniChat settings, providers and tasks](06-infinichat-settings.md) | the settings sheet, the machine's providers with the sign-in relay, the scheduled tasks sheet, notifications | ~500 |
| 7 | [Chats](07-chats.md) | `DurableChatService` in the main process, the chats sidebar, the chat screen, chat settings with the directory picker | ~800 |
| 8 | [Providers](08-providers.md) | the Mac's own credential store and sign-in, the Providers pane | ~300 |
| 9 | [Release](09-release.md) | icon, signing, notarization, the updater, publishing to GitHub Releases | ~200 |

About 4,500 lines plus CSS. The phone's own code for the same features (`apps/mobile/src` without the pi-env daemon
client, keep-alive and the native auth module) is about 5,000. A piece that grows to several times its size means its
design is wrong; stop and revisit it.

## Deviations (approved 2026-10-27)

1. **`InfiniChatMoves` without local files.** The Mac never holds the conversation itself, so `choose(null)`,
   `refresh` and the phone↔machine paths have no meaning there. `files` becomes optional in `move.ts:339`, and those
   paths refuse without it (~10 lines). The alternative, a `DatabaseFiles` whose every method rejects, keeps the
   package untouched but lies in its types.
2. **Moves into the package, no edits:** `apps/mobile/src/chat/shown-infinichat.ts` (imports only package types) to
   `packages/infinichat/src/pi/shown-infinichat.ts`; `apps/mobile/server/sign-in.ts` and `credentials.ts` (Node, no
   server-only dependency) to `packages/infinichat/src/node/`. The server keeps importing them.
3. **One server bundle for both apps.** The phone and the Mac must install byte-identical bundles: a client whose
   manifest hash differs reinstalls the server (`client.ts:377-379`), so two builds of the same code would reinstall
   each other's server at every connect. `apps/mobile/server/`, the two build scripts, the two generated manifests
   and `assets/{infinichat-server,pi-env}` move to `packages/infinichat-server` (moves only; the phone's two asset
   loaders and the gate commands change paths). Both apps read the bundle and daemons from that package.
4. **Key-based SSH only on the Mac.** pi-env runs `ssh` with `BatchMode=yes` (`dist/ssh.js:57`), so passwords can't be
   used. A machine on the Mac is `user@host:port` reached with the user's own SSH setup (agent, `~/.ssh/config`,
   Tailscale SSH) or a chosen identity file. The phone keeps its password option.
5. **Hutch bundles the main process; Photon's WebAssembly is a copied resource.** pi-durable's `images/node.d.ts`
   says a single-file binary reads its own copy of `photon_rs_bg.wasm` and calls `createPhotonImages()`; `build.copy`
   places it in Resources and `src/main/images.ts` does that. `packages/infinichat/src/node/devices.ts`, whose static
   `.wasm` import serves the server's esbuild bundle, stays server-only.
6. **The link to a remote machine's server rides an `ssh` process the app spawns with pi-env's `sshArguments`**, the
   Mac's counterpart of the phone's second SSH connection and `forwardLocal` (`phone-dialer.ts:71, 85-98`): pi-env
   1.4.0 carries requests and files, not sockets (`connection.d.ts`), and bans forwardings in its own invocations
   (`ssh.js:58`). `-W 127.0.0.1:<port>` on the child's stdio, handed to `ws` through `createConnection`; `-L` to a
   free port if OpenSSH or `ws` refuses it. Installs, checks, moves and tools go through `RemoteExecutionEnv`.
7. **The window bundle adds `react`, `react-dom` and `streamdown`** (with `streamdown/styles.css`): the web
   counterpart of the phone's react-native-enriched-markdown and react-native-streamdown, sanitizing with
   rehype-sanitize and rehype-harden and repairing streamed Markdown with remend.

## Platform differences (not parity gaps)

- No keep-alive or "Background work": macOS doesn't suspend the app; the Live Activity has no counterpart.
- The avatar comes from a file (`Utils.openFileDialog`), not Image Playground, and is served to the page as
  `appdata://avatar/...`.
- Notifications fire at task time while the app runs; Electrobun exposes no tap or action on them, so there is no
  "Run now"/"Open" (the machine runs its tasks itself anyway).
- Machines use the user's SSH identity (deviation 4), so "Password" and "Private key" entry are gone; "Trust new key"
  stays.

## Working on a piece

- AGENTS.md applies: no `any`, no casts or non-null assertions, idiomatic upstream use, no app-added limits, deletion by
  default, design before code. Get the owner's approval for a piece and its listed deviations before implementing.
- Before writing code, re-read the installed upstream sources the piece names: `.hutch/devkit/api` for Electrobun
  (projected by `hutch electrobun prepare`), chord's `docs/guide.md`, and the package files, and record the versions in
  the commit. [references.md](references.md) lists them with lines.
- `hutch` is installed at `~/.hutch/bin/hutch` and is not on `PATH`: run `export PATH="$HOME/.hutch/bin:$PATH"` first.
  All Hutch commands run from `apps/mac`.
- **Rename nothing that is stored**, as `docs/infinichat-package/README.md` says: document kinds, the contract
  `infinichat.remote` and its version, the host name `infinichat-server`, the client file layout, the LaunchAgent label
  `com.vikashloomba.piagent.infinichat`. The Mac's own contract is new and versioned from 1.
- Implementers don't write tests. Verify on this Mac with `hutch run dev` and, for pieces 2, 5 and 6, with the
  phone's Release install as the other client, with the phone's database backed up first.
- Before calling a piece done: `pnpm --filter @pi-agent/mac lint`, `pnpm --filter @pi-agent/mac typecheck`,
  `hutch electrobun build --env=dev`, and the existing gates when the package or the server changed
  (`npx @expo/agent-cli lint`, `npx @expo/agent-cli typecheck`, the server's typecheck, the bundle `--check`).

## Paths

`apps/mac/` holds `hutch.config.ts`, `electrobun.config.ts`, `package.json`, `tsconfig.json`, `src/main/` (the Bun
main process), `src/view/` (the window's code and CSS), `src/contract.ts` (the Mac's Chord contract, shared by both),
`scripts/` (the release script), `icon.iconset`, and the generated, ignored `.hutch/`, `build/`, `artifacts/`. `file:line` references in these docs are as of `18c9dd5`.
