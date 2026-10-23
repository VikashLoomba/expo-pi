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
     observation and the local notifications (`src/pi/infinichat-phone.ts`).
   - **The device tools** (pi-durable's bash, read, write and edit with a required `device`, `callEnv` and the
     devices turn state) move to `src/pi/infinichat/device-tools.ts`, given a device list and an image processor.
     `devices.ts` keeps only the phone's list.
3. Split `ScheduledTaskNotifier` (`src/pi/infinichat-notifications.ts`) the same way:
   - **Host-neutral:** the waiting-task list read from the task graph and `inspect()`, as it reads it after the
     1.4.0 upgrade (`ScheduledTasks`, `src/pi/infinichat-scheduled.ts`).
   - **Phone only:** mirroring into local notifications through `expo-notifications`.

   The Scheduled tasks sheet keeps reading the list.

The phone keeps behaving exactly as before. The point of the split is that `server/` can import the core, the view
(`src/pi/infinichat-view.ts`, `chat-projection.ts`, `chat-metadata.ts`) and the OptChat modules
(`src/pi/infinichat/*` except `devices.ts`) without pulling in an Expo module.

### Shared Chord contract: `src/pi/infinichat-remote/contract.ts`

One `remote("infinichat.remote", …)` contract, imported by the server and, in piece 3, by the phone:

- `host: hostNamed("infinichat-server")`, input `{}`, one principal `{ kind: "owner" }`.
- **State members:**
  - `snapshot`: `{ view, report? }`, the view's `ChatViewSnapshot` plus the service's latest report. Not
    `status`: a reference has its own `status`, and Chord refuses that member name (`src/contract.ts:178-189`).
  - `controls`: `InfiniChatControls`, or null.
  - `messages`: `ChatMessage[]`.
  - `scheduled`: `ScheduledTask[]`.
- **Methods:**
  - `accept({ content, requestId })`
  - `stop()`
  - `updateSettings({ main, summary, instructions, name })`
  - `cancelScheduled({ id, replacement? })`, returning a boolean
  - `dismissError()`

Write the state and arguments as TypeBox schemas and derive the TypeScript types from them. Then the phone reads
typed state with no casts, and Chord validates what the server sends. `ChatMessage`, `ChatControls` and
`ChatViewSnapshot` (`src/chat/types.ts`, `src/pi/chat-view.ts`), `InfiniChatControls` and `ScheduledTask` become
`Static<…>` of those schemas instead of hand-written interfaces. Each schema sits next to the type it replaces, and
so do the nested ones (web search, file tool, model settings, execution settings, images, scheduled input).

- **pi-durable's IDs are plain numbers there.** TypeBox cannot express their brands without `Type.Unsafe`, which
  would mint them from wire data. The side that holds the Harness looks each one up among its records
  (`harness.inspect()`) before using it: `cancelScheduled` in the core, and `steerQueued` and `retryParked` in the
  chat service for ordinary chats.
- **The values are JSON, with no `undefined` anywhere.** Chord rejects `undefined` nested in state
  (`src/delta/README.md:115-119`), and its diff throws on it. The projection omits an absent key instead, as tool
  rows without file details now do.

### The server: `server/`

| File | Responsibility |
| --- | --- |
| `server/main.ts` | Entry. `serve --device <name>`. Paths under `~/.infinichat`, created with mode `0700`. Takes `processLock("infinichat-server")` before anything opens storage. Opens `~/.infinichat/data/infinichat.db` with `openNodeSqliteStorage` (a fresh conversation when none exists; piece 5 adds the active/released state). Opens the core and the Chord host, then listens. On `SIGTERM` and `SIGINT` it shuts down in reverse order (below). Exits non-zero when `harness.closed` reports `failed`, so its service manager restarts it (pi-durable `README.md` "Errors": reopen to recover). |
| `server/devices.ts` | One device, this machine, named with `--device`: the name the phone's Remote machines record uses, so the model's memory of that device stays true after a move. Each call gets `new NodeExecutionEnv({ cwd: ~/.infinichat/work/<who> })`, the same work directory the phone uses for machines (`MACHINE_WORK` in `src/pi/infinichat/device-tools.ts`). The read tool uses `createPhotonImages(wasm)` from `@earendil-works/pi-durable/images`, with Photon's WebAssembly embedded in the bundle: `createNodePhotonImages()` resolves the package at run time, which "a single-file binary cannot" (pi-durable `images/node.d.ts:17-19`). Images are then prepared on the main thread rather than a worker. |
| `server/models.ts` | The same providers as `createChatModels` (`src/pi/models.ts`) with pi-ai's own auth. The phone's `createNativeOpenAIOAuth` is the iOS replacement for pi-ai's Node flow (`src/pi/openai-auth/README.md`). In this piece the credential store is empty, so sending fails with the existing "Sign in…" message; piece 4 adds sign-in. The native web-search decorator is left out: it acts only on requests the chat service's own extension binds, and InfiniChat's Harness installs none. |
| `server/serve.ts` | `host.serve(InfiniChatRemote, …)`. `self.on` follows the core's `view()`, its report and its scheduled list directly; the view attaches while the object follows it. Each change mirrors all four cells with `replace(ctx, value, { diff: true })`, because the projection rebuilds its arrays on every update. Methods call the core with `withAbortSignal(ctx.signal, BACKGROUND_CONTEXT)`, so a dropped link cancels only the call's own waits. A link close aborts that context (Chord `src/connection.ts:1230-1240`) and pi-durable refuses a commit on an aborted context, so the core runs any commit that follows completed work, such as `accept`'s record of the request, on `BACKGROUND_CONTEXT`. |
| `server/listen.ts` | `new WebSocketServer({ host: "127.0.0.1", port: 0 })` from `ws`, because Node has no WebSocket server. It writes `{ pid, port, bundle }` to `~/.infinichat/server.json` once listening, which piece 2 reads, atomically: a temporary file renamed into place. `bundle` is the name of the bundle's directory. Each connection must carry `Authorization: Bearer <secret>`, compared in constant time with `~/.infinichat/secret`. Then `host.accept(webSocketLink(socket, { compress: false, acceptPacked: false }), { principal: OWNER, kind: "client" })`. Without a valid secret the socket is closed. |
| `server/tsconfig.json` | Node types; the app's `tsconfig.json` keeps excluding `server/`. |
| `scripts/build-infinichat-server.mjs` | esbuild bundle of `server/main.ts`: platform node, ESM, target node22. Output: `dist/infinichat-server/server.js` (piece 2 replaced it with the app asset `assets/infinichat-server/server.bin` and its manifest). Photon's `photon_rs_bg.wasm` is resolved from pi-durable's own dependencies (pnpm does not hoist it) and embedded with the binary loader. A `require` banner serves the SDKs that still call `require()` (pi-ai `README.md`, "Bundling and Tree Shaking"). |

Add `ws`, `esbuild`, `@types/ws` and `@types/node` as dev dependencies with `npx @expo/agent-cli install … --dev`.
Pin `@types/node` to 22.x, the runtime floor (pi-durable's `engines`), so the server typecheck refuses newer APIs.
`ws` ends up inside the bundle. Metro never sees `server/`, because nothing under `src/app` imports it. The lint
configuration needs no change: `expo lint` already covers `server/`, and Expo's TypeScript rules turn `no-undef` off,
so Node globals don't matter there.

## Ownership and lifetime

| Resource | Created by | Borrowed by | Cancelled by | Closed by |
| --- | --- | --- | --- | --- |
| Process lock | `main` at start | — | — | `main` last |
| Storage | `main` | the core's Harness | — | the Harness, as it closes ("Seal admission, settle admitted commits, then close storage", pi-durable `src/types.ts:1075`); `main` closes it only when the core never opened |
| Core (Harness, OptChat) | `main` | `serve.ts` objects | `stop()` aborts a turn; never a dropped link | `main`, after the Chord host (Harness close waits for running task code) |
| Chord host | `main` | every link | — | `main`, after the WebSocket server stops accepting; it disposes objects, then links |
| A link | `listen.ts` per connection | Chord | — | Chord, at a disconnect or host close. A dropped link releases its holds (Chord `docs/spec.md:260`). |
| A method call's context | Chord, per call | the core's waits, and a single commit not yet started | the caller, or a link close | settles with the call |

## Deviations (need approval)

- **`compress: false` links** instead of `acceptWebSockets` (approved 2026-10-21).
- **The server runs the app's `InfiniChatView`** and serves its projection, instead of serving `viewState()` raw
  the way upstream's removed server stack did. InfiniChat's transcript needs more than the view: history before
  resets, original inputs from `InputDoc`, `AppDoc.pending` and the task graph. Keeping one projection avoids
  writing it twice.
- **A shared secret on top of SSH.** Loopback is reachable by every account on the machine. The tunnel
  authenticates the phone; the secret keeps other local accounts out.

Found while implementing, against the installed 1.4.0 sources:

- **`snapshot`, not `status`**, which Chord reserves (above).
- **Plain-number IDs, looked up again on the Harness side** (above).
- **Photon embedded, through `createPhotonImages`** (the `server/devices.ts` row).

## Size

Estimated at about 350 lines: the split ~60 (moved, not new), the contract and schemas ~120, `server/` ~170. The Chord
guide's own wiring of a server that owns a Durable Harness is about 30 lines. The rest is InfiniChat's surface and the
process life cycle.

As built: about +480 net lines outside the lockfile, much of it moved. `device-tools.ts` (124) came out of
`devices.ts`, and `infinichat-scheduled.ts` (86) out of the notifier. `server/` is about 235 lines with its
`tsconfig`, and the contract file 48.

## Checks

- **Phone:** lint, typecheck and a Release install. InfiniChat works exactly as before: send, stop, settings,
  Scheduled tasks.
- **A Mac and a Linux machine:**
  - Build the bundle, copy it to `~/.infinichat/server/dev/`, write a secret, and run `node server.js serve
    --device <name>` with Node 22.19+.
  - On macOS, a server started by hand runs with `TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, or through `launchctl`.
    Chord's `processLock` locks a socket file under `os.tmpdir()` there (`src/manager.ts:82-91`, `:133-134`), and
    the piece 2 LaunchAgent gets that per-user `TMPDIR` from launchd; a shell without it locks under `/tmp`, and the
    two servers would not exclude each other.
  - A throwaway Node client on the machine (not committed) connects with the secret and hydrates `snapshot`,
    `controls` and `messages`.
  - A wrong secret is refused.
  - A second server exits because the lock is held.
  - `kill -TERM` shuts down cleanly, and a restart shows the same conversation.

## Not in this piece

Installing over SSH (piece 2), the phone client (piece 3), sign-in (piece 4), moving the phone's conversation
(piece 5), other machines (piece 7).
