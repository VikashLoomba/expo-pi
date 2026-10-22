# InfiniChat on a connected machine

InfiniChat's harness runs on the phone today: pi-durable's Harness, its SQLite storage, the model requests and the
OptChat tasks all live in the app, and only tool calls reach the configured machines over SSH. This feature adds a
machine selector to InfiniChat's header: *This iPhone* or one of the connected machines. Choosing a machine moves the
whole harness there: the conversation's database, the model requests, the summaries, agents and scheduled tasks.
The phone becomes a client that shows the conversation and sends input. Work keeps going while the phone is locked,
asleep or offline. Choosing *This iPhone* moves it back.

The toggle is seamless:
- **The conversation looks the same.** The machine runs the same view code over the same database, so the transcript,
  its message ids and the controls are identical, and the screen keeps showing the last messages until the new
  side's first snapshot arrives.
- **The agent carries on as after a restart.** The side that opens the database resumes the conversation the way
  pi-durable resumes after any restart, which is also how upstream's own session sync hands work over (see
  [piece 5](05-moving-the-conversation.md#what-the-agent-sees)).

Only InfiniChat changes. Ordinary chats keep running on the phone.

## Decisions

Owner decisions of 2026-10-21; implement them as stated.

| Topic | Decision |
| --- | --- |
| Where the server runs | Any configured machine in **Remote machines** (macOS or Linux, arm64 or x64). All of them are reachable over SSH on the Tailscale network the phone is on. No machine is special. |
| How it gets there | The phone installs and starts it over its existing SSH connection, as it provisions the pi-env daemon today. |
| Runtime on the machine | Node ≥ 22.19 (pi-durable's `engines`, built-in `node:sqlite`) must already be installed. Setup stops with a clear message otherwise. Nothing is downloaded. |
| Transport | Chord over a WebSocket, tunnelled through the SSH session with react-native-ssh's `forwardLocal`. The server listens on the machine's loopback only. |
| Chord compression | The server creates each link with `webSocketLink(socket, { compress: false, acceptPacked: false })` instead of `acceptWebSockets`. Hermes has no `DecompressionStream`, which Chord's compressed frames need ([evidence](references.md#chord-over-websocket-in-hermes)). |
| Phone device | Not offered while InfiniChat runs on a machine. Files in the phone's `/workspace` stay on the phone until InfiniChat moves back. |
| Machines its tools use | The machine running InfiniChat, plus the other configured machines that machine reaches with its own SSH keys (pi-env `connectSsh`). The others come last ([piece 7](07-other-machines.md)). |
| Model credentials | The idiomatic pi way: the process that runs the Harness owns a pi-ai `CredentialStore`. You sign in through `models.login(provider, type, interaction)`, with its prompts relayed to the phone. Nothing is copied from the phone ([piece 4](04-credentials-and-sign-in.md)). |
| The toggle | A pull-down menu in InfiniChat's header, beside Scheduled tasks: *This iPhone* and the configured machines, with a checkmark on the current one. The conversation UI doesn't change when it is used. |
| Moving the conversation | Each toggle hands the storage over: close the Harness on one side, copy the database file over SSH, open it on the other. Nothing is kept in continuous sync. This does not depend on `pi-durable/sync`. The copy sits behind one seam, so upstream's replication can replace it once it is released ([piece 5](05-moving-the-conversation.md)). |
| In-flight work | Nothing waits or drains. The side that opens the database resumes interrupted work with pi-durable's own recovery, exactly as upstream's sync test hands a running generation over ([piece 5](05-moving-the-conversation.md#what-the-agent-sees)). |
| Scheduled-task notifications | The phone notifies at each task's time wherever InfiniChat runs. While InfiniChat runs on a machine, the task starts there on its own; opening the notification shows the agent already working ([piece 6](06-scheduled-tasks-and-background.md)). |
| Restart limit (pi 1.4.0) | InfiniChat's Harness: `restartLimit: Infinity`. Ordinary chats: upstream's default, showing parked tasks with a retry. Part of the 1.4.0 upgrade. |

## Architecture

```text
 iPhone (client)                                    Machine A (owns the conversation)
 ┌───────────────────────────────┐   SSH session   ┌────────────────────────────────────────────┐
 │ InfiniChat screens            │  (host key      │ node ~/.infinichat/server/<sha>/server.js  │
 │   └ RemoteInfiniChat          │   pinned,       │   processLock("infinichat")                │
 │       Chord client host       │   Keychain      │   pi-durable Harness + OptChat core        │
 │       webSocketLink ──────────┼── forwardLocal ─┼─▶ ws://127.0.0.1:<port> (secret checked)  │
 │                               │                 │   Chord server host: infinichat.remote    │
 │ Moves: SSH exec upload/cat    │──── exec ───────┼─▶ ~/.infinichat/data/infinichat.db         │
 └───────────────────────────────┘                 │   models: own CredentialStore (0600 file)  │
                                                   │   tools: A (NodeExecutionEnv), B, C (pi-env)│
                                                   └────────────────────────────────────────────┘
```

- **One owner at a time.** pi-durable: "One process owns a storage at a time; there is no cross-process locking"
  (pi-durable `README.md:682`). The phone's record of where InfiniChat lives decides which side may open the
  database. The server also takes Chord's `processLock` before it opens storage, so it never runs twice.
- **The view is computed where the Harness is.** The server runs the app's existing `InfiniChatView` and serves its
  output (status, controls, messages) as Chord state. The phone renders the same `ChatViewSource` it renders today.
  Chord sends a snapshot, then diffs, and re-holds after a reconnect.
- **Same code on both sides.** The OptChat core in `src/pi/infinichat/*` imports only pi libraries. The server
  bundles that code with the view and the contract, built from this repo's lockfile, so the phone and the server
  always run the same pi-durable. pi-durable's SQLite migrations are one-way, so a version mismatch must never
  open a moved database.

## Prerequisite

Upgrade the app to pi **1.4.0** first, as its own task (see the next-release notes in the project memory). These
docs target 1.4.0 APIs: `TaskRuntime.sleepUntil`, the required `checkpointWhen`, SQLite schema v2, `restartLimit`,
the required `Context.telemetry` for custom contexts, and `@earendil-works/chord/sqlite`. If 1.4.0 changes an API a
piece names, follow 1.4.0 and update the piece.

## Pieces

Implement in order. Each piece leaves the app working. Until piece 5 lands, choosing a machine shows that machine's
own, new conversation; the phone's conversation stays untouched on the phone.

| # | Piece | Builds | Est. size |
| --- | --- | --- | --- |
| 1 | [Core on Node and the server process](01-core-on-node.md) | Host-neutral InfiniChat core, `server/` package, Chord contract, loopback WebSocket | ~350 lines |
| 2 | [Install and run over SSH](02-install-over-ssh.md) | Server bundle as an app asset, provisioning, user service, version handshake | ~300 lines |
| 3 | [Phone client and the selector](03-phone-client.md) | SSH tunnel, Chord client host, `RemoteInfiniChat`, the header menu | ~350 lines |
| 4 | [Credentials and sign-in](04-credentials-and-sign-in.md) | Server credential store, relayed `models.login`, server catalog | ~220 lines |
| 5 | [Moving the conversation](05-moving-the-conversation.md) | Phone → machine and back, home record, recovery | ~340 lines |
| 6 | [Scheduled tasks and the background](06-scheduled-tasks-and-background.md) | Notifications from the machine's waiting tasks, keep-alive off when remote | ~80 lines |
| 7 | [Other machines](07-other-machines.md) | pi-env `connectSsh` from the server, host keys accepted from the phone | ~240 lines |

Sizes are rough estimates before any code exists, about 1,900 lines in all. The app's nearest existing analogues:
the pi-env daemon provisioning (`src/pi/execution/remote/provisioning.ts`, 95 lines) for piece 2, and the remote
execution owner (`owner.ts`, 110 lines) for piece 3. Upstream's own wiring for a Chord server that owns a Durable
Harness is about 30 lines (Chord `docs/guide.md:712-784`). The experimental server stack upstream deleted on
2026-10-12 was 7,056 lines in its three packages alone (7472cda0d). A piece that grows to several times its
estimate means its design is wrong; stop and revisit it.

## Working on a piece

- AGENTS.md applies: no `any`, no casts or non-null assertions, idiomatic upstream use, no app-added limits,
  deletion by default, design before code. Each piece file is that design. Get the owner's approval for a piece and
  its listed deviations before implementing.
- Before writing code, re-read the installed upstream sources the piece names, at the installed version. Record the
  versions used in the commit.
- Every piece lists who creates, borrows, cancels and closes each resource. Keep operation cancellation separate
  from shutdown.
- Implementers don't write tests. Verify on the owner's iPhone Release install (back up the InfiniChat database
  first; see the project memory for the commands) and on at least one real machine. Report source assessment,
  device checks and unverified behaviour separately.
- Run `npx @expo/agent-cli lint`, `npx @expo/agent-cli typecheck` and the server's own typecheck before calling a
  piece done.

## References

[references.md](references.md) lists the upstream contracts, the probe results and the measurements these pieces
rely on, with versions and `file:line`.
