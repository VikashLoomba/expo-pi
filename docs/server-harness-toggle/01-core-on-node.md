# Piece 1: Core on Node and the server process

## Goal

InfiniChat's harness runs in a Node process on a machine and serves its conversation over Chord on the machine's
loopback. In this piece the process is started by hand. Nothing on the phone changes what the user sees.

## Starts from

- Chord guide, pi 1.4.0, `packages/chord/docs/guide.md`:
  - "Durable" (`:756`): the Harness is a resource of a host object.
  - "Hosts and links" (`:712`): a server accepts client links stamped with a principal.
  - The `Chat` object with `view`, `send` and `stop` (`:367`).
  - "State": mirroring an external immutable store into a cell with `replace` (`:444`).
- pi-durable `README.md` "Persist and Resume" (`openNodeSqliteStorage`, `:127`), and examples 26 and 29: an
  environment per conversation built from `NodeExecutionEnv`.
- `processLock(name)` from `@earendil-works/chord/node` (`src/manager.ts:76-82` at v1.4.0): "The child acquires it
  (before opening storage), so the lock follows the process that owns the data."
- The probe from 2026-10-21 ([references](references.md#chord-over-websocket-in-hermes)): the same host, link and
  mirroring pattern served a real Harness to a client in the app's Hermes runtime.

## Builds

### Host-neutral split in the app (no change on the phone)

1. `src/pi/model-catalog.ts` imports `DEFAULT_JPEG_QUALITY` from `./images`, and `images.ts` pulls in
   `expo-file-system` and `expo-image-manipulator`. Move the constant so the catalog and the view import on Node.
2. Split `InfiniChatService` (`src/pi/infinichat-service.ts`):
   - **The host-neutral core:** opening OptChat, `accept`, `stop`, `updateSettings`, `cancelScheduled`, `view()`,
     `waitForAnswer`, the report store and `close`. It takes its devices (tools, `callEnv`, `turnState`) as an
     argument.
   - **The phone host:** what stays phone-only: `createDevices(workspaces, remote, remoteHosts)`, the keep-alive
     observation and the local notifications.
3. Split `ScheduledTaskNotifier` (`src/pi/infinichat-notifications.ts`) the same way:
   - **Host-neutral:** the waiting-task list read from the task graph and `inspect()`, as it reads it after the
     1.4.0 upgrade.
   - **Phone only:** mirroring into local notifications through `expo-notifications`.

   The Scheduled tasks sheet keeps reading the list.

The phone keeps behaving exactly as before. The point of the split is that `server/` can import the core, the view
(`src/pi/infinichat-view.ts`, `chat-projection.ts`, `chat-metadata.ts`) and the OptChat modules
(`src/pi/infinichat/*` except `devices.ts`) without pulling in an Expo module.

### Shared Chord contract: `src/pi/infinichat-remote/contract.ts`

One `remote("infinichat.remote", …)` contract, imported by the server and, in piece 3, by the phone:

- `host: hostNamed("infinichat-server")`, input `{}`, one principal `{ kind: "owner" }`.
- **State members:**
  - `status`: the view's `ChatViewSnapshot` plus the service's latest report.
  - `controls`: `InfiniChatControls`, or null.
  - `messages`: `ChatMessage[]`.
  - `scheduled`: `ScheduledTask[]`.
- **Methods:**
  - `accept({ content, requestId })`
  - `stop()`
  - `updateSettings({ main, summary, instructions })`
  - `cancelScheduled({ id, replacement? })`, returning a boolean
  - `dismissError()`

Write the state and arguments as TypeBox schemas and derive the TypeScript types from them. Then the phone reads
typed state with no casts, and Chord validates what the server sends. `ChatMessage`, `ChatControls` and
`ChatViewSnapshot` (`src/chat/types.ts`, `src/pi/chat-view.ts`) and `ScheduledTask` become `Static<…>` of those
schemas instead of hand-written interfaces.

### The server: `server/`

| File | Responsibility |
| --- | --- |
| `server/main.ts` | Entry. `serve --device <name>`. Paths under `~/.infinichat`. Takes `processLock("infinichat-server")` before anything opens storage. Opens `~/.infinichat/data/infinichat.db` with `openNodeSqliteStorage` (a fresh conversation when none exists; piece 5 adds the active/released state). Opens the core and the Chord host, then listens. On `SIGTERM` and `SIGINT` it shuts down in reverse order (below). Exits non-zero when `harness.closed` reports `failed`, so its service manager restarts it (pi-durable `README.md` "Errors": reopen to recover). |
| `server/devices.ts` | One device, this machine, named with `--device`: the name the phone's Remote machines record uses, so the model's memory of that device stays true after a move. Each call gets `new NodeExecutionEnv({ cwd: ~/.infinichat/work/<who> })`, the same work directory the phone uses for machines (`MACHINE_WORK` in `src/pi/infinichat/devices.ts`). The read tool uses `createNodePhotonImages()` from `@earendil-works/pi-durable/images/node`. |
| `server/models.ts` | The same providers as `createChatModels` (`src/pi/models.ts`) with pi-ai's own auth. The phone's `createNativeOpenAIOAuth` is the iOS replacement for pi-ai's Node flow (`src/pi/openai-auth/README.md`). In this piece the credential store is empty, so sending fails with the existing "Sign in…" message; piece 4 adds sign-in. |
| `server/serve.ts` | `host.serve(InfiniChatRemote, …)`. A resource subscribes to the core's `view()` and its scheduled list. `self.on` handlers mirror each update into the cells with `replace(ctx, value, { diff: true })`, because the projection rebuilds its arrays on every update. Methods call the core with `withAbortSignal(ctx.signal, BACKGROUND_CONTEXT)`, so a cancelled call cancels only its own wait. |
| `server/listen.ts` | `new WebSocketServer({ host: "127.0.0.1", port: 0 })` from `ws`, because Node has no WebSocket server. It writes `{ pid, port, bundle }` to `~/.infinichat/server.json` once listening, which piece 2 reads. Each connection must carry `Authorization: Bearer <secret>`, compared in constant time with `~/.infinichat/secret`. Then `host.accept(webSocketLink(socket, { compress: false, acceptPacked: false }), { principal: OWNER, kind: "client" })`. Without a valid secret the socket is closed. |
| `server/tsconfig.json` | Node types; the app's `tsconfig.json` keeps excluding `server/`. |
| `scripts/build-infinichat-server.mjs` | esbuild bundle of `server/main.ts`: platform node, ESM, target node22. Output: `dist/infinichat-server/server.js`. |

Add `ws`, `esbuild`, `@types/ws` and `@types/node` as dev dependencies with `npx @expo/agent-cli install … --dev`.
`ws` ends up inside the bundle. Metro never sees `server/`, because nothing under `src/app` imports it. Add
`server/` to the lint configuration with Node globals.

## Ownership and lifetime

| Resource | Created by | Borrowed by | Cancelled by | Closed by |
| --- | --- | --- | --- | --- |
| Process lock | `main` at start | — | — | `main` last |
| Storage | `main` | the core's Harness | — | `main`, after the core |
| Core (Harness, OptChat) | `main` | `serve.ts` objects | `stop()` aborts a turn; never a dropped link | `main`, after the Chord host (Harness close waits for running task code) |
| Chord host | `main` | every link | — | `main`, after the WebSocket server stops accepting; it disposes objects, then links |
| A link | `listen.ts` per connection | Chord | — | Chord, at a disconnect or host close. A dropped link releases its holds (Chord `docs/spec.md:260`). |
| A method call's context | Chord, per call | the core's waits | the caller | settles with the call |

## Deviations (need approval)

- **`compress: false` links** instead of `acceptWebSockets` (approved 2026-10-21).
- **The server runs the app's `InfiniChatView`** and serves its projection, instead of serving `viewState()` raw
  the way upstream's removed server stack did. InfiniChat's transcript needs more than the view: history before
  resets, original inputs from `InputDoc`, `AppDoc.pending` and the task graph. Keeping one projection avoids
  writing it twice.
- **A shared secret on top of SSH.** Loopback is reachable by every account on the machine. The tunnel
  authenticates the phone; the secret keeps other local accounts out.

## Size

About 350 lines: the split ~60 (moved, not new), the contract and schemas ~120, `server/` ~170. The Chord guide's own
wiring of a server that owns a Durable Harness is about 30 lines. The rest is InfiniChat's surface and the process
life cycle.

## Checks

- **Phone:** lint, typecheck and a Release install. InfiniChat works exactly as before: send, stop, settings,
  Scheduled tasks.
- **A Mac and a Linux machine:**
  - Build the bundle, copy it to `~/.infinichat/server/dev/`, write a secret, and run `node server.js serve
    --device <name>` with Node 22.19+.
  - A throwaway Node client on the machine (not committed) connects with the secret and hydrates `status`,
    `controls` and `messages`.
  - A wrong secret is refused.
  - A second server exits because the lock is held.
  - `kill -TERM` shuts down cleanly, and a restart shows the same conversation.

## Not in this piece

Installing over SSH (piece 2), the phone client (piece 3), sign-in (piece 4), moving the phone's conversation
(piece 5), other machines (piece 7).
