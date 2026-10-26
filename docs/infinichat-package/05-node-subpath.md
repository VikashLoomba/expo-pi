# Piece 5: The `node` subpath

## Goal

The Node implementations of the package's seams live in `packages/infinichat/src/node/`, imported as
`@pi-agent/infinichat/node/…`. The server uses them from there, and the Mac app will too. Nothing runs differently.

## Starts from

- **pi-durable's own layout:** a host-neutral core plus Node subpaths. The server already imports
  `@earendil-works/pi-durable/env/node` (`server/devices.ts`) and `@earendil-works/pi-durable/storage/sqlite/node`
  (`server/conversation.ts`).
- **The server's Node code** in `server/`, written in pieces 1-8 of `docs/server-harness-toggle`.
- **Pieces 2 and 4:** the package and its seams (`PagePlatform` extended to `DatabaseFiles`, `CredentialBackend`).

## Builds

### What moves

Only code the server uses today and the Mac app needs for the same job:

| From | To `packages/infinichat/src/node/` | Why the Mac needs it |
| --- | --- | --- |
| `server/pages.ts`: the Node `PagePlatform` (`node`), the backup in `writeDiff` | `database-files.ts`: the Node `DatabaseFiles` | Its side of a move |
| `server/conversation.ts`: `describe`, `fold` | `database-files.ts` | The same |
| `server/credentials.ts`: `fileCredentialBackend` | `credentials.ts` | A file backend for sign-ins and the server secret, unless the framework's keychain replaces it |
| `server/models.ts`: `createServerModels` | `models.ts` | The same providers as the phone, over its own credential store |
| `server/devices.ts`: `serverDevices` | `devices.ts` | Its own device and the other machines, when InfiniChat runs on the Mac |
| `server/machines.ts`: `ServerMachines` | `machines.ts` | The other machines through pi-env, fed from the Mac's settings through `set` |

### What stays in `server/`

`main.ts`, `serve.ts`, `listen.ts`, `state.ts`, `conversation.ts`'s `ServerConversation` (adopt, relinquish,
archive), `sign-in.ts`, `credentials.ts`'s `openAILoginOptions`, and the page commands (`writePages`, `writeDiff`,
`writePatch`), rebuilt on the Node `DatabaseFiles`. These are the server's role. A Mac that serves the phone runs the
server itself, the same bundle, so it needs no copy of them.

Nothing moves for the Mac app's dialers or settings yet. They get no caller until the Mac app exists.

### Imports and the lint guard

- Extend the package's lint guard (piece 2): files under `src/node/` may import `node:*`, pi-env and Photon's
  WebAssembly. The rest of the package may import neither `node:*` nor anything under `node/`.
- `machines.ts` imports `@earendil-works/pi-env`, which today is a development dependency of the app, since the app
  bundles the server. Declare it in the package as an optional peer dependency
  (`peerDependenciesMeta: { "@earendil-works/pi-env": { "optional": true } }`), so the iOS app needs nothing new.
- `devices.ts` imports Photon's WebAssembly as bytes. The server build maps it with an esbuild alias and the `binary`
  loader (`scripts/build-infinichat-server.mjs`), and that still works from the package. The Mac app's bundler will
  need the same mapping.

## Ownership and lifetime

Unchanged. `server/main.ts` still creates and closes `ServerMachines`, the credential store and the conversation, in
the same order.

## Deviations (need approval)

None.

## Size

About 400 lines move, most of them `machines.ts` (245). The page commands get a few lines shorter once they use the
Node `DatabaseFiles`.

## Checks

- `pnpm exec tsc -p server`, lint, and the app's typecheck.
- Rebuild the server asset in the main checkout, then run `--check`. The bundle's hash changes.
- On the iPhone Release install, with the database backed up:
  - Choose vikash-system: the phone reinstalls the server, and the transcript appears.
  - The machine's sign-ins still show as signed in, and a message gets an answer: the credentials file reads.
  - A tool call on another configured machine, through vikash-system: pi-env from the package.
  - One move each way: the Node `DatabaseFiles`.

## Not in this piece

The Mac app itself: its dialers, its settings, its keychain backend, and whether it runs the server as a LaunchAgent
or inside the app.
