# A shared InfiniChat package

A macOS desktop app is planned that reuses InfiniChat. It serves as a machine the iPhone can move InfiniChat to, and
it connects to the other configured machines the way the iPhone does. The iPhone is never reachable from the Mac.

Before that app exists, the code that doesn't depend on where it runs moves into one workspace package. The iOS app,
the Node server and the Mac app all build from it. These docs say how, piece by piece. Nothing is extracted yet, and
nothing a user sees changes.

## Owner decisions (2026-10-26)

| Topic | Decision |
| --- | --- |
| What to extract | The OptChat (UniiChat) core on pi-durable, `InfiniChatService`, `InfiniChatView`, the remote contract and the page diffs: the code that runs anywhere. |
| RemoteInfiniChat | Included, split at Chord's `Link`. The Chord half goes into the package; each app supplies how it reaches a machine's server ([piece 3](03-link-seam.md)). |
| `install.ts` and `move.ts` | Included now, not after the Mac app's platform is chosen ([piece 4](04-install-and-move.md)). |
| The Mac app's runtime | A desktop framework with a Node- or Bun-compatible runtime, a file system and the usual desktop capabilities. |
| Machine work in install and move | Through pi-durable's `ExecutionEnv`, not an app-defined interface ([piece 4](04-install-and-move.md#why-executionenv)). |
| Ordinary chats | The Mac has its own ordinary chats, as the phone has its own, so the ordinary chat service moves into the package ([piece 6](06-ordinary-chats.md)). |
| The server's single-client code | Not a product choice: it gets fixed to follow Chord's and pi-durable's model, so several clients can use one server ([piece 7](07-several-clients.md)). |
| These docs | Guidance first. The extraction is a later task, one piece at a time. |

## What is shared

The server already bundles InfiniChat from `src/`, so the files it imports are, by construction, the ones that run
anywhere. Following `server/main.ts`'s imports into `src/` reaches 35 files, 5,338 lines, that import only pi packages.
The one exception is a type-only import of `src/pi/secure-storage.ts`, which piece 1 removes
([references](references.md#the-shared-set)).

```text
                    packages/infinichat: no host APIs
  ┌──────────────────────────────────────────────────────────────────────┐
  │ OptChat core · InfiniChatService · InfiniChatView · remote contract  │
  │ page diffs · RemoteInfiniChat (Chord half) · moves · install scripts │
  └──────────────────────────────────────────────────────────────────────┘
       seams: Storage · ExecutionEnv · Link · PagePlatform · small app stores
  ┌────────────────────┐   ┌──────────────────────────┐   ┌──────────────────┐
  │ iOS app (Expo)     │   │ server/ (Node)           │   │ Mac app (Node)   │
  │ expo-sqlite,       │   │ packages/infinichat/node │   │ packages/        │
  │ react-native-ssh,  │   │ + pi-env, ws             │   │ infinichat/node  │
  │ expo-file-system   │   │                          │   │ + pi-env         │
  └────────────────────┘   └──────────────────────────┘   └──────────────────┘
```

## The seams

Each app plugs into the package at these points. Three are upstream's, and the rest are small app interfaces. Every
one already has a phone implementation in the app, and a Node implementation in `server/` or in pi-env.

| What it's for | Seam | iPhone (exists) | Node: server and Mac (exists) |
| --- | --- | --- | --- |
| Opening InfiniChat locally | pi-durable `Storage` (upstream) | `openExpoSqliteStorage` | `openNodeSqliteStorage` |
| The tools' devices | pi-durable `ExecutionEnv` (upstream), through `Device.environment` | `WorkspaceExecutionEnv`, `MobileRemoteExecutionEnv` | `NodeExecutionEnv`, pi-env `RemoteExecutionEnv` |
| Reaching a machine's server | Chord `Link` (upstream) | SSH tunnel and React Native's `WebSocket` (`client.ts:408`, `open`) | A loopback WebSocket with `ws` for its own server; an `ssh -L` tunnel for others |
| Files and commands on a machine, for install and move | pi-durable `ExecutionEnv` (upstream) | `MobileRemoteExecutionEnv` from `owner.ts` | pi-env `RemoteExecutionEnv`; `NodeExecutionEnv` for the Mac itself |
| The local database's files: digest, gzip, read, write, folding the WAL, backup, describe, rename | `PagePlatform` (`pages.ts:12`), extended | `move.ts`'s `phone` and its file helpers | `server/pages.ts`, fold and describe in `server/conversation.ts` |
| Where InfiniChat lives (home record) | App: synchronous get and set | expo-sqlite kv-store | A file or `node:sqlite` |
| Secrets: the server secret, sign-ins | `CredentialBackend` (app; exists) | expo-secure-store | `server/credentials.ts`'s file, or the framework's keychain |
| The machine list: names, descriptions, the others | App: a read-only store | `RemoteHostRepository` | The Mac's own settings; host keys through pi-env, as `server/machines.ts` does |
| The server bundle and daemon binaries an install uploads | App: a loader | expo-asset (`server-assets.ts`, `daemon-assets.ts`) | A file among the app's resources; pi-env's `packagedDaemon()` |

## Pieces

Implement in order; piece 6 depends only on pieces 1 and 2, and piece 7 changes code that pieces 3 and 4 move, so it
comes after them. Each piece leaves the iOS app and the server working.

| # | Piece | Builds | Rough size |
| --- | --- | --- | --- |
| 1 | [Fix the leaks](01-fix-the-leaks.md) | `CredentialBackend` moves next to its user; the boundary files are named | ~10 lines |
| 2 | [Workspace and core](02-workspace-and-core.md) | Expo's monorepo layout: the app in `apps/mobile`, `packages/infinichat` with the 35 files, 48 importers updated, a lint guard | moves only, plus a few small files |
| 3 | [The `Link` seam](03-link-seam.md) | RemoteInfiniChat's Chord half in the package; the phone's dialer in the app | `client.ts` (527 lines) split; ~150 lines become the dialer |
| 4 | [Install and move](04-install-and-move.md) | The move logic, the home record's logic and the install scripts in the package; machine work through `ExecutionEnv` | ~1,180 lines move; should shrink by ~100 |
| 5 | [The `node` subpath](05-node-subpath.md) | The server's Node implementations in `packages/infinichat/src/node` | ~400 lines moved |
| 6 | [Ordinary chats](06-ordinary-chats.md) | `DurableChatService` in the package, taking its images, environments and keep-alive from the app | ~20 lines changed; can follow piece 2 directly |
| 7 | [Several clients](07-several-clients.md) | The server's single-client code fixed: a credential per client, the server's own machine list, the holder recorded on the machines | ~150 lines |

A piece that grows to several times its size means its design is wrong; stop and revisit it.

## Working on a piece

- AGENTS.md applies: no `any`, no casts or non-null assertions, idiomatic upstream use, no app-added limits, deletion
  by default, design before code. Get the owner's approval for a piece and its listed deviations before implementing.
- Before writing code, re-read the installed upstream sources the piece names, at the installed version, and record
  the versions in the commit.
- **Rename nothing that is stored.** Moving files changes no behaviour as long as these stay exactly as they are:
  document kinds and task names (`optchat.*`), document and task versions, the Chord contract `infinichat.remote` and
  its version, the host name `infinichat-server`, the home record key `pi.infinichat.home.v1`, the secret keys
  `pi.infinichat.secret.v1.*`, the LaunchAgent label and the systemd unit name. A rename would need pi-durable
  migrations or a reinstall on every machine.
- Leave `docs/infinichat` (the OptChat guide) alone. It stays reference material with its own `package.json`.
- Rebuild the server asset in the main checkout, never in a worktree: a worktree with symlinked `node_modules` embeds
  `../../../` paths, so `--check` fails in the main checkout. Any piece that changes what the server imports changes the
  bundle's hash, so the phone reinstalls and restarts the server on each machine at its next connect. The pi versions
  stay the same, so nothing migrates, and the server reopens the conversation from `state.json`.
- Implementers don't write tests. Verify on the owner's iPhone Release install and on at least one real machine. Back
  up the phone's InfiniChat database first (see the project memory for the commands). Report source assessment,
  device checks and unverified behaviour separately.
- Before calling a piece done, run `npx @expo/agent-cli lint`, `npx @expo/agent-cli typecheck`, the server's typecheck
  (`pnpm exec tsc -p server`) and `node scripts/build-infinichat-server.mjs --check`.

## Paths

Paths and `file:line` references in these docs are as of `348f26a`. After piece 2, the app's files, including
`server/` and `scripts/`, are under `apps/mobile/`, and the moved files under `packages/infinichat/src/`. The
commands in "Working on a piece" then run from `apps/mobile`. Since the Mac app's piece 2 (docs/mac-app), the server,
its scripts, manifests and assets are `packages/infinichat-server`: its gates are `pnpm --filter
@pi-agent/infinichat-server typecheck` and `pnpm --filter @pi-agent/infinichat-server check`.

## References

[references.md](references.md) lists the evidence these pieces rely on: versions, upstream contracts with `file:line`,
the import walk, and the probes.
