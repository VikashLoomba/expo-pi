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

### Move back (machine A → phone)

1. Set the home record to `{ A, moving-back }`. Call `release()`.
2. Download the files it named by streaming `cat` into a `File` writable stream (expo-file-system 58), and verify
   their SHA-256.
3. Rename them into place over `infinichat-moved.db`, then open the local core. pi-durable resumes interrupted work.
4. Set the home record to `phone`. Call `archive()`.

**Recovery.** At launch, `moving-back` resumes from step 2; the server stays released. Cancelling before step 3 calls
`adopt()` again (the server's files are unchanged) and sets the record to `{ A, there }`.

### What the user sees

- **The transcript doesn't change.** Both sides run the same `InfiniChatView` over the same database, so the
  messages, their ids and the controls are identical.
- **The screen doesn't reload.** While the move runs it keeps the last messages, and it switches its source once the
  new side's first snapshot has arrived. It doesn't remount, so the scroll position and the composer's draft stay
  put; a draft sent during the move keeps its `requestId` and is admitted once, on the new side.
  - Piece 3 doesn't do this yet: at a toggle `chat-provider.tsx` sets `infiniChat` to `undefined` before it opens the
    other side, so every InfiniChat screen drops to loading in between. This piece has to keep the old host's last
    values on screen until the new one has its first snapshot, instead of clearing it.
- **A reply being streamed starts over.** pi-durable's recovery resets the generation to pending, so the partial
  answer is generated again on the new side.
- **Only the header changes:** its subtitle shows the step (closing, copying with bytes of total, opening on
  <machine>), then the machine's name.
- **The menu:** disabled while a move runs, and offering a machine only when its server is reachable and its bundle
  matches. Failures name the step that failed. A machine that is unreachable while InfiniChat lives there can't be
  moved back from, and the header says so.

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

Moving is the only thing that closes one side and opens the other. Operation cancellation (`stop()`) never moves
anything.

## Deviations (need approval)

- **File copy instead of replication.** Decided; behind one seam (`moveThere` and `moveBack` in
  `src/pi/infinichat-remote/move.ts`).
- **The `adopt`, `release` and `archive` lifecycle methods.** They encode pi-durable's single-owner rule as
  explicit hand-offs.

## Size

About 340 lines: home record and recovery ~80, transfer over SSH ~120, server lifecycle methods ~60, UI ~80.

## Checks

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
