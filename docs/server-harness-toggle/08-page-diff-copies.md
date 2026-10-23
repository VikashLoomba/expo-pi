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
- When the last connection to a database closes, SQLite checkpoints and deletes its WAL. ~~Opening and closing a
  database once folds a leftover WAL into it.~~ Superseded: a probe showed the WAL stays unless a statement reads it,
  so folding runs `PRAGMA wal_checkpoint(TRUNCATE)` (see [As built](#as-built)).
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
- The files a move copies are always one WAL-free database: the phone folds a WAL its close left before it describes
  its files (as built, with `wal_checkpoint(TRUNCATE)`, not by opening and closing), and the server does the same in
  `relinquish`. `ConversationFiles` loses `wal`, and with it the WAL branches of `upload`, `download`, `parts`,
  `rename` and `describe` callers. The machine's `state.json` from piece 5 already parses without it.
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

- On launch and each time the app returns from the background, after `moves.resume()`, unless a move is running or
  the home record is mid-move. Returning from inactive (Control Center, the notification pull-down) doesn't refresh
  (owner, 2026-10-22), by the rule that already decides when the machine's link is replaced.
- A move that starts aborts a refresh in progress. A refresh writes only the receiver's copy, aside and renamed into
  place, so an abort leaves the old copy.
- A refresh to a machine needs that machine's current server bundle installed; it doesn't install one, and skips the
  machine when it is missing.

## Who owns what

| Resource | Created by | Closed by |
| --- | --- | --- |
| A move's SSH connection | `InfiniChatMoves` (piece 5); as built, `upload` and `download`, with a second one for the whole file when the patch's failure dropped the first | the same function, in `finally` |
| A refresh's SSH connection and `AbortController` | the refresh | the refresh, in `finally`; aborted by a move, the app going to the background, or the provider unmounting |
| The phone's second database connection for a backup | the phone-holds refresh | the same refresh, after the backup |
| The phone's backup file, `infinichat-backup.db` | the phone-holds refresh | the same refresh, in `finally` |
| A patched copy's file aside, `<name>.partial` on the phone, `<name>.<pid>` on the machine | `apply`'s write | the same write, which renames it into place |
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

As built, after the review, +522 −124 outside the docs, the asset and its manifest, 398 net: `pages.ts` 108,
`server/pages.ts` 56 and `main.ts` +14, `conversation.ts` +24 (fold, `archive`), `move.ts` +183 (diff path,
refreshes, the fallback's own connections, less the WAL branches), and 13 elsewhere: the provider +7, the home
record +4, `install.ts` +2, `listen.ts` +1, Remote machines +1, `state.ts` −2, the contract 0.

## As built

Against pi-durable, chord and pi-ai 1.4.0, Expo 58.0.17 (expo-sqlite 58.0.13, expo-file-system 58.0.10, expo-crypto
58.0.7) and nitro-zlib 0.3.1.

Where this piece was silent:
- **Formats.** Both start with the page size (32 bits) and a file size (float64). A patch then has the new file's
  SHA-256 (32 bytes), the count, the page numbers (32 bits each) and the pages, all gzipped. A page list of another
  page size shares no page.
- **`pages.ts` takes paths for databases and bytes for what travels:** `pages(platform, db)`, `diff(platform, db,
  list)`, `apply(platform, base, patch, out)`. The phone keeps the list or patch it sends in memory. What it receives
  goes through one `infinichat-transfer` file, removed once read.
- **Machine files** are `mktemp` files in `~/.infinichat`, removed by the script that reads them. The move back's
  patch waits there for the download, the one step after it. Every page script runs `server.js` of this app's bundle
  with the `node` from `server.json`, and fails when either is missing, so a move falls back and a refresh stops.
- **Fallback:** any failure on the patch path, unless the move was cancelled, sends the whole file as before. A move
  back's patched result is checked against `relinquish`'s files too, and a mismatch falls back. `upload` and
  `download` own their SSH connection, made by the move's `connect`. When the patch's failure took it down (a
  dropped link makes `runSshCommand`'s `fail` disconnect it), they let it go and make a new one for the whole file;
  react-native-ssh's `isConnected` says which. A missing copy keeps the live connection, with no second handshake.
- **Progress:** "Copying to/from <machine>" without bytes until the patch's size is known, then the patch's bytes.
- **gzip level:** each library's default (nitro-zlib 9, Node 6).
- **A refresh is a method of `InfiniChatMoves`.** The provider's `open(refresh)` calls it at launch and on a return
  from the background. `run` stops one and waits for it before a move starts. `stopRefresh` runs on `background`, and
  `forget(machineId)` is called by Remote machines after a removal.
- **A cancelled move there** sets the record back to plain `phone`, so `copyOn` waits for the next move back.

Departures, each found while building:
- **Folding uses `PRAGMA wal_checkpoint(TRUNCATE)`, not open and close alone.** Opening and closing with no statement
  left a 4 MB WAL in place (Node probe). SQLite opens the WAL at the first read. The server's fold also checks
  `busy` with chord's 5 s busy timeout. Chord's close already checkpoints, but a `diff --live` reading at that moment
  makes the checkpoint fail, and that close doesn't report it.
- **`diff --live` copies in one step** (`backup(source, path, { rate: -1 })`, as expo-sqlite's `backup_step(-1)`), from
  a read-only connection. A backup in steps starts over whenever another connection commits between steps, which the
  server's Harness does every 100 ms while it streams. Read-only also means a missing database fails instead of
  being created.
- **The page scripts trap PIPE.** sshd leaves a script running after its channel closes, and its next write kills it
  with SIGPIPE. POSIX runs the exit trap on an exit, not on such a death: macOS's `sh` ran it anyway in a probe, but
  a shell that doesn't would leave the page list or patch behind. The whole-file upload traps it too.

Known limitations, left as they are:
- expo-sqlite's iOS `backupDatabaseAsync` ignores `sqlite3_backup_step`'s result
  (`expo-sqlite/ios/SQLiteModule.swift:304-305`, 58.0.13), so a backup that meets BUSY can resolve with an empty
  destination. The phone-holds refresh then fails in `pageSize` and is skipped.
- `moveSync` with `overwrite` removes the destination, then moves the file aside into place. A kill in between
  leaves no copy, and the next move sends the whole file.
- `node` in `server.json` is written only when the server starts. A Node upgrade that removes the old binary makes
  moves fall back to the whole file, and refreshes skip, until the server restarts.

## Checks

Done on the implementer's Mac (Node 25.6.1), on copies of the owner's data: the phone's copy from the 11:04 move
(39.2 MB) and vikash-system's database ten hours later (42.3 MB).
- The built `server.js`: `pages` of the base, then `diff` of the newer file, gave a 3,142,655-byte patch of 2,642 of
  10,337 pages (10.8 MB raw). `patch` produced the newer file's SHA-256 (`13d49c01…`), byte for byte. Each command
  took 190–370 ms, about 150 ms of it Node loading the bundle.
- A base with one byte changed in a page the patch doesn't carry failed with "The patched copy doesn’t match the
  database it was made from.", exit 1. `<out>` was left as it was, with no file set aside.
- `diff --live` took 0.45–0.5 s, on a closed copy and on a copy that another process committed to every 20 ms. Its
  patch verified, and the result passed `integrity_check` with the rows committed before the backup. A missing
  database failed without being created. On vikash-system's Node 24.15.0, `diff --live` with `rate: -1` took 0.56 s
  and gave a 3,143,101-byte patch whose result passed `integrity_check`.
- The real `upload`, `download`, `receivePatch`, `refreshCopy` and `phoneFiles` of `move.ts`, bundled for Node with
  Expo stubbed over Node, ran over a fake SSH connection that runs each command in a local `sh`. Both moves sent a
  3.1 MB patch. With no copy, or no server bundle, they sent the whole 42.3 MB. Placing was refused while active.
  A link dropped during the patch (the page list's download, the patch's upload, or the move back's diff) fell back
  to the whole file over a second connection, and both were closed. A missing copy kept the one connection.
  Both refreshes, against a database another process was committing to, gave copies that passed `integrity_check`.
  A refresh stopped mid-diff, by a hangup or by a silent channel close, left the old copy and no files on either side.
  A 0.8 MB leftover WAL was folded.

Done on the owner's iPhone Release install of 4d85f59 (2026-10-23), with the conversation on vikash-system:

- The phone reinstalled the server (bundle `4e8017543a887ac7…`). Its user unit starts `/bin/bash -lc 'exec "$0"
  "$@"' <node> server.js serve …`, its process's `PATH` has nvm's Node 24.15.0, `server.json` names that `node`,
  and `~/.infinichat` has no `.pages` or `.patch` file left.
- The launch refreshed `infinichat-moved.db` (05:56). Read back with `devicectl`, its SHA-256 (`045226c3…`) equals
  that of a backup of the machine's database taken afterwards with `rate: -1`, and it passes `integrity_check`.

Still unverified, on the owner's iPhone Release install, with the conversation on vikash-system:

- A move back sends a patch, not the whole file. Its progress total is the patch size, and the conversation opens
  on the phone as before.
- A move there sends a patch against `copy/infinichat.db`.
- Corrupt a copy (for example, delete it on the machine): the move falls back to the whole file.

Moving the owner's live conversation needs the owner's go.
