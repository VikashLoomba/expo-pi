# Piece 8: Page-diff copies

## Goal

Moving InfiniChat between the phone and a machine copies only the database pages that changed, not the whole file.
When the app becomes active, the side that holds the conversation also refreshes the other side's copy the same
way, so the next move has little left to send. Nothing the user sees changes, except that moves get faster.

## Owner decisions (2026-10-22)

- Page diff now, behind piece 5's copy seam, compressed with `@strawberrytech/react-native-nitro-zlib` (installed,
  0.3.1). pi-durable/sync replaces it once upstream releases it.
- Sync on app open, both ways: from the machine that holds the conversation to the phone, and from the phone to the
  machine it last moved back from.
- Still open, not in this piece: what happens when a machine is removed while it holds the conversation (piece 5,
  "Open question for the owner"). The fresher phone copy this piece keeps is an input to that decision.

## Starts from

- Piece 5's seam: `upload` and `download` in `src/pi/infinichat-remote/move.ts`, the one place that copies bytes. The
  handover stays as it is: the giving side closes its Harness, the bytes are copied, the other side opens them and
  pi-durable's recovery resumes interrupted work.
- SQLite's database file is a sequence of fixed-size pages; the page size is the big-endian 16-bit value at byte 16
  of the header (1 means 65536). A consistent copy of a database that is open elsewhere comes from SQLite's backup
  API, which writes the same pages at the same page numbers:
  - phone: expo-sqlite `backupDatabaseAsync({ sourceDatabase, destDatabase })`
    (`node_modules/expo-sqlite/build/SQLiteDatabase.d.ts:416`, SDK 58);
  - machine: `node:sqlite` `backup(sourceDb, path)` (Node ≥ 22.16; the server requires 22.19).
- When the last connection to a database closes, SQLite checkpoints and deletes its WAL. Opening and closing a
  database once folds a leftover WAL into it.
- gzip on the phone: `deflateAsync(data, 'gzip', level)` / `inflateAsync(data, 'gzip')` from the nitro-zlib package,
  off the JS thread. On the machine: `node:zlib`. Probe (2026-10-22, simulator dev build against vikash-system's
  Node 24.15.0): gzip written on each side is read byte for byte by the other; 10.8 MB deflated in 0.36 s and
  inflated in 0.34 s; 10,337 SHA-256 page digests with expo-crypto took 0.08 s.
- Measured on the owner's data (the phone's copy from the 11:04 move against vikash-system's database ten hours
  later, 42.3 MB): 2,642 of 10,337 pages changed, 10.8 MB raw, 3.1 MB gzipped, against 42.3 MB for today's whole
  copy.

## Builds

### The copies

Each side keeps one copy of the conversation it doesn't hold. A copy is a single closed database file with no WAL,
never opened by a Harness:

| Side | Holds the conversation | Its copy while the other side holds it |
| --- | --- | --- |
| Phone | `infinichat.db` | `infinichat-moved.db` (piece 5's name), left by the move there |
| Machine | `~/.infinichat/data/infinichat.db` | `~/.infinichat/copy/infinichat.db`, left by the move back |

- `archive` (after a move back) moves the released database to `copy/infinichat.db`, replacing the old copy, instead
  of renaming `data/` into `released/`. `released/` stays only for the upload's set-aside of a stray database.
- The files a move copies are always one WAL-free database: the phone folds a WAL its close left (open, close) before
  it describes its files, and the server does the same in `relinquish`. `ConversationFiles` loses `wal`, and with it
  the WAL branches of `upload`, `download`, `parts`, `rename` and `describe` callers. The machine's `state.json` from
  piece 5 already parses without it.
- The phone's home record remembers the machine whose copy it keeps fresh: `{ version: 1, home: 'phone', copyOn?:
  machineId }`, set when a move back finishes. An existing record without it parses as before. Removing that machine
  from Remote machines clears it.

### The page format (`src/pi/infinichat-remote/pages.ts`, shared by phone and server)

- **Page list**: the SHA-256 of each page of a file, concatenated (32 bytes per page), with the page size and file
  size in front.
- **Patch**: gzip of a header (page size, the new file's size and SHA-256, the changed page numbers) followed by those
  pages. A page is changed when its number is past the receiver's list or its hash differs.
- **Apply**: read the base whole, put the changed pages at their offsets, cut or extend to the new size, check the
  result's SHA-256 against the header, then write it aside and rename it into place. Whole-file reads match what
  `upload` already does with the phone's database.
- The module takes the platform's digest, gzip and file access as arguments; the phone passes expo-crypto,
  nitro-zlib and expo-file-system, the server `node:crypto`, `node:zlib` and `node:fs`.

### Machine commands

`server.js` gains commands beside `serve`, run over the move's SSH connection with the same Node the server runs:
`listen.ts` adds `node: process.execPath` to `server.json`, and the phone's script reads it from there.

- `pages <db> <out>`: writes the page list of a WAL-free copy.
- `diff <db> <pages> <out> [--live]`: writes the patch of `<db>` against the receiver's page list. With `--live` it
  first backs up the open database to a temporary file and diffs that.
- `patch <base> <patch> <out>`: applies a patch, verifies it, and renames the result to `<out>`.

Bytes travel as today: uploads through `runScript` with input, downloads with `downloadFile` (`cat` after a marker).

### The four flows

| When | Sender | Receiver's base | Result |
| --- | --- | --- | --- |
| Move there | phone's closed `infinichat.db` | machine `copy/infinichat.db` | `data/incoming/infinichat.db`, then piece 5's placing and `adopt` |
| Move back | machine's relinquished `data/infinichat.db` | phone `infinichat-moved.db` | `infinichat-incoming.db`, then piece 5's rename and open |
| App active, machine holds | backup of the machine's open database (`diff --live`) | phone `infinichat-moved.db` | `infinichat-moved.db` replaced |
| App active, phone holds | backup of the phone's open database (a second connection, `useNewConnection`) | machine `copy/infinichat.db` on `copyOn` | `copy/infinichat.db` replaced |

Each flow: the receiver's page list goes to the sender's side, the patch comes back, the receiver applies and
verifies it. A move whose receiver has no copy, or whose patch fails at any step, copies the whole file as today. A
refresh that fails changes nothing and is tried again at the next activation; it reports nothing, since the next move
still works.

### When refreshes run

- On launch and each time the app becomes active, after `moves.resume()`, unless a move is running or the home record
  is mid-move.
- A move that starts aborts a refresh in progress. A refresh writes only the receiver's copy, aside and renamed into
  place, so an abort leaves the old copy.
- A refresh to a machine needs that machine's current server bundle installed; it doesn't install one, and skips the
  machine when it is missing.

## Who owns what

| Resource | Created by | Closed by |
| --- | --- | --- |
| A move's SSH connection | `InfiniChatMoves` (piece 5) | the move, in `finally` |
| A refresh's SSH connection and `AbortController` | the refresh | the refresh, in `finally`; aborted by a move, the app going to the background, or the provider unmounting |
| The phone's second database connection for a backup | the phone-holds refresh | the same refresh, after the backup |
| The machine's temporary backup for `diff --live` | the `diff` command | the same command |
| Patch and page-list files on either side | the step that writes them | the step that reads them, which removes them |

## Deviations (need approval)

- **A page diff instead of upstream's replication.** Upstream's mechanism is commit-log batches, unreleased on the
  `replication` branch. This piece keeps upstream's handover and changes only the bytes on the wire; it reads
  SQLite's file format and backup API, not pi-durable's tables. Approved 2026-10-22.
- **Copies refresh while a side holds the conversation.** Piece 5 decided "Nothing is kept in continuous sync"; the
  owner changed that on 2026-10-22.

## Size

Estimated at about 370 lines net: `pages.ts` ~80, the machine commands ~90 plus ~20 for folding WALs in
`relinquish` and the new `archive`, the move's diff path ~90, the refreshes ~90, provider and home record ~30, less
~30 of WAL handling removed. Upstream's sync module is 895 lines on the `replication` branch, before its storage
changes.

## Checks

On the owner's iPhone Release install, with the conversation on vikash-system:

- After the install, the app's first activation refreshes `infinichat-moved.db`. Its SHA-256 matches a backup of
  the machine's database taken by the same `diff --live` (read the phone's file back with `devicectl`).
- A move back sends a patch, not the whole file. Its progress total is the patch size, and the conversation opens
  on the phone as before.
- A move there sends a patch against `copy/infinichat.db`.
- Corrupt a copy (for example, delete it on the machine): the move falls back to the whole file.

Moving the owner's live conversation needs the owner's go.
