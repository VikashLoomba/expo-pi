# Piece 5: Moving the conversation

## Goal

Choosing a machine in InfiniChat's header moves the phone's InfiniChat conversation there, and choosing *This
iPhone* brings it back. The conversation UI doesn't change, the agent carries on, nothing is lost or doubled, and
the two sides never both have it open.

## Starts from

- pi-durable 1.4.0:
  - "One process owns a storage at a time; there is no cross-process locking" (`README.md:790`).
  - "Work interrupted by a crash or close stays pending. `resume()` starts the task scheduler" (`README.md:127`).
  - The 1.4.0 crash-loop guard: "a close writes the tasks it stopped back as `pending` uncounted"
    (`CHANGELOG.md:22`). So a clean close before a move costs no restart count.
- Chord's `processLock` (piece 1): the server never opens storage twice.
- The upload pattern of `provisioning.ts`: temporary file, SHA-256, atomic rename. Uploads use `openShell` with
  input, as `command-channel.ts`'s `runSshCommand` does: react-native-ssh's `exec` has no stdin (README "Planned")
  and caps output at 16 MiB (`src/errors.ts:20`). Downloads stream from `openShell({ term: "", command: "cat …" })`.
- SQLite closes cleanly: when the last connection closes, SQLite checkpoints and deletes the WAL file.
- How upstream's own session sync hands over work in flight (branch `replication` at `2cf6cd898`,
  `packages/durable/test/sync-e2e.test.ts:143-171`):
  1. A device uploads while its generation is still running.
  2. The other device pulls and opens a Harness on its copy. Opening commits the recovery write that resets the
     running generation to `pending` (`restarts: 1`), and that device carries the run on.

  There is no drain or pause; the rule is "Only the device that drives a session opens a Harness on it" (the
  branch's `README.md`, "Replication"). This piece hands over the same way, with a closed Harness on the giving side
  and a file copy in place of upload and pull.

`pi-durable/sync` itself is not used (owner decision). See [Later: upstream replication](#later-upstream-replication).

## Builds

### State on each side

- **Phone, the home record** (app settings storage, like `pi.remote-hosts.v1`). It replaces piece 3's choice and is
  the authority on who may open the conversation:

  ```ts
  type Home =
    | { version: 1; home: "phone" }
    | { version: 1; home: "machine"; machineId: string; phase: "moving-there" | "there" | "moving-back" };
  ```

- **Server, `~/.infinichat/state.json`:** `{ active: boolean, adopted?: { db: string; wal?: string } }`, the
  SHA-256 of what it adopted. The server opens storage only while `active`. A reboot reopens it.
- **New owner-only methods** on the contract:
  - `adopt()`: open the files in `data/`, set `active`. Refused while active.
  - `release()`: stop accepting input, close the core (Harness close waits for running task code) and the storage,
    clear `active`, and return the files' SHA-256.
  - `archive()`: rename `data/` to `released/<timestamp>/`, never to be opened again. Refused while active.

As built:
- **The home record** is `pi.infinichat.home.v1` in expo-sqlite's kv-store, written with the synchronous API before
  the step that needs it (`src/pi/infinichat-remote/home.ts`). It starts at `phone`. Piece 3's
  `pi.infinichat.machine.v1` is not read: the app is unreleased (AGENTS.md: no compatibility with stored selections),
  and the phone's conversation was never moved before this piece, so starting at `phone` opens it where it is. A
  record that doesn't parse throws instead of guessing a side, since a wrong guess could open the conversation twice.
- **`state.json`** is read, changed and written back synchronously by every writer (`server/state.ts`, which replaces
  `time-zone.ts`): `{ active, adopted?, timeZone? }`. `adopted` is kept only while `active`.
- **The files are named by SHA-256 and size:** `{ db: { sha256, size }, wal?: { sha256, size } }`
  (`ConversationFilesSchema`). The size gives the header its "bytes of total".
- **The methods** (`server/conversation.ts`, `ServerConversation`, one at a time on a queue):
  - `adopt(files)` takes the files the phone verified and refuses others. It writes `active` before it opens, so a
    crash while opening reopens them at the restart, and clears it again when the open fails.
  - `relinquish()`, not `release()`: Chord reserves `release` for a reference's own method (chord
    `src/contract.ts:179-193` at v1.4.0). It names the files in `data/` and, called again, names them again, because
    a move back resumed at launch needs their names and the home record keeps none.
  - `archive()` as specified; again it changes nothing.
- **A `conversation` state member,** `{ active, adopted? }`, so the phone can apply the recovery rule.
- **While inactive the server serves no core:** the view is `loading`, the transcript empty, and the conversation's
  operations refuse with "InfiniChat isn't open on <machine>."; sign-in and the time zone still work.
- **The device keeps the phone's description too:** install passes the device list's own text for the machine
  (`machineDescription` in `src/pi/infinichat/device-tools.ts`) as `--description`, and the client's handshake
  checks it with the name. Piece 1 described the machine as its own `user@hostname`.

### Move there (phone → machine A)

1. Install or update the server (piece 2). The bundle must match the phone's manifest, so both sides run the same
   pi-durable and no one-way migration runs on a copy the other side can't read.
2. Set the home record to `{ A, moving-there }`. Close the local InfiniChat core, then its storage.
3. Upload the database file (its path is the expo-sqlite connection's `databasePath`), plus its `-wal` file if one
   remains. Never upload `-shm`. They go to `~/.infinichat/data/incoming/`, where they are verified and renamed into
   `data/`. The step is refused if the server is active.
4. Call `adopt()`. The server opens the conversation and resumes any run the close interrupted.
5. Set the home record to `{ A, there }`. Rename the phone's files to `infinichat-moved.db`, which is never opened,
   and keep them until the next successful move back. Nothing is cleared.

**Recovery.** At launch, a home record still in `moving-there` resumes from step 3, using the phone's files, which
are the truth until `adopt` has succeeded. If the server is already active with an `adopted` hash equal to the
phone's files, the move did finish, so continue at step 5. Cancelling before `adopt` sets the record back to
`phone` and reopens locally.

As built (`moveThere` is `InfiniChatMoves.there` in `src/pi/infinichat-remote/move.ts`):
- **Step 1 is the client's own connect** (`RemoteInfiniChat.connected`), which installs or updates as piece 3 does and
  only succeeds against this bundle's server for this device. Nothing on the phone is closed before it succeeds, so an
  unreachable machine leaves the phone's conversation open and the record at `phone`.
- **The phone's files** are found in expo-sqlite's `defaultDatabaseDirectory`, the folder `databasePath` is built
  from (`src/SQLiteDatabase.ts:583`, `src/pathUtils.ts:24-36`), because recovery runs with no connection open. Its
  declaration is `any`; the code reads it as `unknown` and checks it is a string.
- **The upload** is two scripts per file and one to place them, over one SSH connection of the move's own:
  - each file goes to `data/incoming/` through `runSshCommand` with input (64 KiB writes), is checked by SHA-256 and
    renamed there, as provisioning.ts uploads the daemon;
  - the place script refuses when `state.json` says `"active":true`. A database already in `data/` (a released copy
    whose `archive` didn't run, or a machine's own conversation from pieces 3 and 4) is moved to
    `released/<time>-<pid>/` rather than overwritten. Then it removes any old `-wal` and `-shm` there, moves the
    WAL (when one was uploaded) and the database into `data/`.
- **No timeout on the transfers.** A copy ends with its last byte, the user's Cancel or the SSH connection, whose
  keepalive notices a dead machine; a fixed bound would fail a large conversation on a slow link. `runSshCommand`
  gains `timeoutMs: null` for that and `onWritten` for the progress; every other step keeps its 60 s.
- **Step 5's rename can't fail the move.** Under either name the phone's copy is never opened while the machine holds
  the conversation, and the next move back replaces it.
- **Cancel** stays possible until `adopt` is called, and is the only way into the undo; Try Again, and the app
  becoming active, always carry the move forward, also after a Cancel that failed. A Cancel during a running attempt
  that has seen the server inactive reopens the phone at once, also with the machine unreachable. A Cancel after a
  failure first connects, since the failed attempt may have reached `adopt` with its answer lost. A machine that holds
  the phone's files open then has the conversation and may be working on it, so the Cancel finishes the move instead,
  the only outcome that never opens the conversation twice, and a notice says so: "InfiniChat had already opened on
  <machine>, so the move finished and it runs there now. Choose This iPhone to move it back."

### Move back (machine A → phone)

1. Set the home record to `{ A, moving-back }`. Call `release()`.
2. Download the files it named by streaming `cat` into a `File` writable stream (expo-file-system 58), and verify
   their SHA-256.
3. Rename them into place over `infinichat-moved.db`, then open the local core. pi-durable resumes interrupted work.
4. Set the home record to `phone`. Call `archive()`.

**Recovery.** At launch, `moving-back` resumes from step 2; the server stays released. Cancelling before step 3 calls
`adopt()` again (the server's files are unchanged) and sets the record to `{ A, there }`.

As built (`moveBack` is `InfiniChatMoves.back`):
- **It connects before step 1,** so a machine that can't be reached fails the move with nothing changed: the record
  stays `there` and the screens keep showing the machine. This is how "the header says so" is built.
- **Step 2 resumed at launch calls `relinquish()` again** for the files' names, and downloads them to
  `infinichat-incoming.db` (and `-wal`) through `openShell({ term: '', command })` into `File.writableStream()`.
  - The command prints a marker line, then `exec cat`s the file, and the bytes count from after the marker, as
    install.ts's answers do: sshd runs the command through the account's shell, whose startup files may print (zsh's
    `~/.zshenv`, or `~/.bashrc` where bash sources it for SSH), and those bytes would fail the hash every time.
  - The file is created first, because the stream's handle opens with `FileHandle(forWritingTo:)`, which needs an
    existing file (expo-file-system `ios/FileSystemFileHandle.swift:67`).
  - Each file is verified with `File.digest('SHA-256')` (`ios/FileSystemFile.swift:59`) and its size.
  - A Cancel also disconnects the move's own SSH connection, as `runSshCommand`'s `fail` does, so a dead link doesn't
    hold the Cancel until the keepalive gives up.
- **Steps 3 and 4 swap the record and the open:** the files are placed (the WAL first, after removing every
  `infinichat.db*` and `infinichat-moved.db*`), then the record says `phone`, then the local core opens. The placed
  files are the conversation from then on and nothing has opened them yet, so a relaunch never downloads over work
  the phone has already done. The spec's order (open, then the record) left that window.
- **`archive()` is best effort.** A server never opens released files, and the next move there sets a leftover aside
  (above), so a failed archive is ignored.
- **Cancel** is possible until the files are placed: it calls `relinquish()` for the names when the server is still
  active, then `adopt()`, and sets the record back to `there`.

### What the user sees

- **The transcript doesn't change.** Both sides run the same `InfiniChatView` over the same database, so the
  messages, their ids and the controls are identical.
- **The screen doesn't reload.** While the move runs it keeps the last messages, and it switches its source once the
  new side's first snapshot has arrived. It doesn't remount, so the scroll position and the composer's draft stay
  put; a draft sent during the move keeps its `requestId` and is admitted once, on the new side.
  - Piece 3 doesn't do this yet: at a toggle `chat-provider.tsx` sets `infiniChat` to `undefined` before it opens the
    other side, so every InfiniChat screen drops to loading in between. This piece has to keep the old host's last
    values on screen until the new one has its first snapshot, instead of clearing it.
  - As built, `useChatApp().infiniChat` is one `ShownInfiniChat` for the app's lifetime
    (`src/chat/shown-infinichat.ts`), an `InfiniChatHost` with one view and one set of stores. A move calls `hold()`,
    which stops following the old side and keeps its last values; `show(side)` follows the new side's view and
    switches once its status isn't `loading`. With nothing shown yet (a launch), or no screen subscribed, it switches
    at once.
  - A send while held rejects with "InfiniChat is moving. Send again once the move is done." The draft is unchanged,
    so sending it again on the new side keeps its `requestId`, and OptChat admits it once. Queuing calls through a move
    would need a mechanism of its own; nothing asks for one.
  - The machine's server writes the `snapshot` cell last when it mirrors the core. Past Chord's flow-control window,
    each member's state waits in a slot of its own and the slots flush in the order they were made (chord
    `docs/spec.md:242`; `src/connection.ts:331`). With `snapshot` first, the realistic conversation's first `ready`
    reached the phone before its 1,433 messages, and the screens switched to an empty transcript. Writing it last
    orders that first `ready` only because no snapshot slot is waiting then (the server was inactive, the link idle):
    a later snapshot joins a slot already waiting, wherever that sits (`src/connection.ts:466-495`). Chord guarantees
    order only within one member's stream (`docs/spec.md:287`).
- **A reply being streamed starts over.** pi-durable's recovery resets the generation to pending, so the partial
  answer is generated again on the new side.
  - As built, and as after any restart: pi-durable commits a streamed partial every 100 ms (README `:502`), and the
    resumed generation turns the partial it finds into an assistant entry with `stopReason: "aborted"` before it asks
    again (`convertPartial`, `src/harness/generation.ts:429-438`, called at `:214` and `:307`). So the transcript
    shows the user's turn once, the partial as a stopped answer, and the complete answer after it. The model is asked
    once on each side. An app killed mid-stream leaves the same rows today.
- **Only the header changes:** its subtitle shows the step (closing, copying with bytes of total, opening on
  <machine>), then the machine's name.
- **The menu:** disabled while a move runs, and offering a machine only when its server is reachable and its bundle
  matches. Failures name the step that failed. A machine that is unreachable while InfiniChat lives there can't be
  moved back from, and the header says so.
  - As built, the subtitle reads "Connecting to <machine>…" (or install's stages, from the machine client's own
    connection, as piece 3 shows them), "Closing InfiniChat…", "Copying to <machine> · 12.3 of 43.5 MB", "Opening on
    <machine>…"; back, "Closing on <machine>…", "Copying from <machine> · …", "Opening on This iPhone…"; then the
    machine's name as before. A stopped move reads "Can’t move to <machine>" or "Can’t move from <machine>";
    "Cancelling the move…" while a Cancel runs, and "Couldn’t cancel the move" when it failed.
  - The error notice names the step ("Copying InfiniChat to Studio failed. …") with "Try Again", which carries the move
    forward. A stopped move is also carried forward when the app becomes active, as piece 3 reconnects.
  - The menu's items are disabled while a move runs or a failure stopped one, and it gains a destructive "Cancel Move"
    while Cancel can still put the conversation back. The checkmark is on where the conversation is going, and back
    where it was while a Cancel runs or after one failed.
  - Offering a machine "only when reachable and of this bundle" is step 1: the menu doesn't probe every machine. A
    machine that can't be reached or updated stops the move at "Connecting to <machine>…" with nothing closed.
  - **No move from machine to machine.** While InfiniChat lives on a machine, the other machines are disabled; it moves
    back to This iPhone first. Nothing asks for a direct move.
  - A machine removed from Remote machines while the conversation is on it now says "This machine was removed from
    Remote machines while InfiniChat’s conversation is on it." Piece 3's "Choose This iPhone or another machine" no
    longer applies: both need the machine. See the open question below.

### What the agent sees

The conversation resumes as it does after any restart of the app. Specifically:
- **The machine keeps its name.** The server's own device uses the name of the phone's machine record (piece 1),
  with the same description text the phone's device list gives it.
- **Paths stay the same.** Its work directory stays `~/.infinichat/work/<who>`, so files InfiniChat made on A from
  the phone are where the moved conversation expects them.
- **Same time zone.** The server's service runs with the phone's time zone (piece 2). The agent reads message times
  as local time (`toLocaleString("sv-SE")` in `src/pi/infinichat/tools.ts:109` and `schedule.ts:43`), so a machine
  in another zone would otherwise shift its clock.
- **An interrupted tool call says so.** A device tool call cut by the close gets pi-durable's interrupted result
  (`README.md` "Tools": a tool "reruns on reopen only when it is declared `replay: \"safe\"`"). `bash`, `read`,
  `write` and `edit` declare no replay policy, so this is the same result an app kill gives today. Replay-safe
  calls (`spawn`, `tell`, `schedule_task`) rerun.
- **"phone" disappears.** It is no longer in the device list, which the turn state prints at every message
  (`src/pi/infinichat/devices.ts`). A call naming it fails as an unknown device, as any unknown name does today.
  This follows the owner's decision not to offer the phone remotely.
- **Scheduled tasks** move with the database and wait or sleep on whichever side owns it.

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| The move | the header menu | the user's Cancel, before the opening step only | the move itself |
| SSH connection for files | the move | the move's signal | the move |
| Local core and storage | `chat-provider` | — | closed by the move before step 3 (there) or opened after step 3 (back) |
| Server core and storage | `adopt()` | `stop()` cancels turns only | `release()` |
| `InfiniChatMoves` (as built) | `chat-provider`, once per mount | its `close()` at unmount stops a move where it is; the record carries it on | — |
| The machine's client during a move (as built) | `chat-provider` (`machine()`), for the move's machine | — | `closeMachine()` after a move back or a cancelled move there; it lets go at once and closes on the storage queue |
| `ShownInfiniChat` (as built) | `chat-provider`, once | — | never; it holds no resource, only the last values |
| The phone's moved and incoming copies (as built) | step 5 there; step 2 back | — | the next move back's placing step |

Moving is the only thing that closes one side and opens the other. Operation cancellation (`stop()`) never moves
anything.

## Deviations (need approval)

- **File copy instead of replication.** Decided; behind one seam (`moveThere` and `moveBack` in
  `src/pi/infinichat-remote/move.ts`).
- **The `adopt`, `release` and `archive` lifecycle methods.** They encode pi-durable's single-owner rule as
  explicit hand-offs.

Found while implementing, against the installed sources (pi 1.4.0, tag `4a080252f`; Expo 58.0.17, expo-sqlite 58.0.13,
expo-file-system 58.0.10, react-native-ssh 0.3.0):
- **`relinquish`, not `release`**, which Chord reserves; it is repeatable (Builds).
- **Files named by SHA-256 and size; `adopt` verifies them; a `conversation` state member** (Builds).
- **A database already in `data/` is set aside in `released/`,** never overwritten (Move there).
- **No timeout on the transfers** (Move there).
- **The record says `phone` before the local open** on the way back (Move back).
- **Both moves connect before they change anything** (Move there, Move back).
- **`archive` is best effort** (Move back).
- **The server writes `snapshot` last,** for Chord's per-member flow control (What the user sees).
- **A send during a move rejects;** resending the same draft is admitted once (What the user sees).
- **No machine-to-machine move; no probing of machines for the menu** (What the user sees).
- **The device's description is the phone's text** (Builds).
- **No reading of piece 3's stored choice** (Builds).

## Open question for the owner

A machine removed from Remote machines while the conversation is on it can't hand it back: the move needs the
machine's admission, and adding the machine again makes a new record with a new ID. The conversation stays on the
machine (released or not), and the phone keeps its pre-move copy as `infinichat-moved.db`. Options: block removing
that machine in Remote machines, or offer to reopen the phone's moved copy (losing what happened on the machine).
Nothing is built for either.

## Size

About 340 lines: home record and recovery ~80, transfer over SSH ~120, server lifecycle methods ~60, UI ~80.

As built, +1,389 −252 lines outside the docs and the asset, 1,137 net, so over three times the estimate. The
README says a piece that grows to several times its estimate needs revisiting; this one is for the owner's review.
- **New:** `move.ts` 509 (a fifth of it comments), `shown-infinichat.ts` 156, `server/conversation.ts` 197,
  `server/state.ts` 68 (replacing `time-zone.ts`, 35), `home.ts` 52 (replacing `machine-choice.ts`, 26).
- **Changed:** the provider +136 −74, the InfiniChat screen +79 −34, `client.ts` +60 −9, `serve.ts` +52 −30, the
  contract +23, `main.ts` +18 −18, `command-channel.ts` +10 −3, `install.ts` +10 −6, and a few lines elsewhere.

Where it went beyond the estimate:
- the seamless switch (`ShownInfiniChat`), which the estimate's "UI ~80" didn't cover;
- Cancel in both directions, and a move a failure stopped (its status, Try Again, the undo), about 120 of `move.ts`;
- the server following a core that comes and goes (adopt, relinquish) for its one Chord object, and its operation
  queue;
- the two transfers with progress, and the recovery checks (a machine that already adopted, a repeatable
  `relinquish`).

## Checks

Done in this piece on the implementer's Mac, with no device available. The results are in
[references](references.md#piece-5-on-macos). Everything below is still unverified.

Back up the phone's InfiniChat database first (project memory has the commands), then on the owner's iPhone Release
install with the real conversation:

- **Idle move:** move to a Mac and send; move back and send. The transcript is whole on both sides.
- **Mid-run move:** move during a streaming reply. The run resumes on the machine, and the transcript shows no
  duplicate turn.
- **Scheduled task:** a waiting task survives a move each way and fires on the side that owns it.
- **Interrupted copy:** kill the app mid-copy, in each direction. The relaunch resumes, and neither side ever has it
  open twice.
- **Speed:** measure the copy time of the real database (32 MB plus a 4 MB WAL in the 2026-10-21 backup).

## Later: upstream replication

As of 2026-10-21, upstream's storage-level replication (`ReplayableStorage`: `log(after)`, `replay(record)`,
`head()`) is solid and tested. The session-sync layer built on it is less than a day old, and it is not in 1.4.0
([references](references.md#upstream-session-sync)). When a pi release ships the storage layer, the copy steps can
become `log(otherHead)` → `replay` without changing the home record, the hand-offs or the UI. Until a release
ships, don't run that branch's code on real data: it stamps databases with an unreleased SQLite schema v3.
