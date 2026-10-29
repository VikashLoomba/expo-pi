# Piece 9: Page patches between machines

## Goal

A move between two machines sends only the pages that changed since the target last held the conversation, as the
phone's moves already do, instead of the whole database. The owner, 2026-10-28, after a move from the Mac to
vikash-system took as long as the 92 MB file: "we should leverage that system for changing machines too in both the
mobile and desktop app".

## What the package does today

- **The page diffs** (`pages.ts`): a page list is the SHA-256 of each page of a closed database; a patch is the gzipped
  pages whose hash differs from a copy's; `apply` turns the copy into the database and verifies its SHA-256. Each
  side brings its own digest, gzip and file access (`PagePlatform`).
- **The phone's moves patch** (`move.ts:214-317`): `sendPatch` sends the phone's database as a patch against the
  machine's copy at `~/.infinichat/copy/infinichat.db`, applied by the server's `patch` command; `receivePatch`
  sends the phone's copy's page list up, runs the server's `diff` command and downloads the patch, applying it to
  the phone's moved copy. `upload` and `download` fall back to the whole file when there is no copy or the patch
  fails. `refresh` keeps the copies fresh.
- **A machine keeps its copy.** After it hands the conversation over, `archive` moves the released database to
  `~/.infinichat/copy/` (`conversation.ts:166-180`), where the phone's next move there patches it.
- **A move between machines copies the whole file.** The target's `pull` reads the source's released database
  through the pi-env environment the target's own SSH gives it, in 4 MB chunks (`conversation.ts:186-209`), and
  never looks at the copy it keeps. Both apps' moves between machines go through it (`move.ts` `between`).

## Builds

- `packages/infinichat/src/pi/infinichat-remote/transfer.ts`: the patch transport moves out of `move.ts` as it is,
  exported: `Copy`, `copyFrom`, `copyTo`, `sendPatch`, `receivePatch`, `serverLines(bundle)` (the lines that find
  the server bundle and its Node on the other machine, built in `copy()` today). `Copy` gains `transfer`, the path of
  the downloaded patch, which the phone names as today and the server under its `data/incoming/`.
- `packages/infinichat/src/node/database-files.ts`: `nodeDatabaseFiles` gains the `open`, `remove` and `rename` a
  receiver needs, over `node:fs`, so it is a whole `DatabaseFiles`.
- `packages/infinichat-server/src/conversation.ts`: `pull` builds a `Copy` of the source (its environment, this
  machine's files, the move's signal, the source's name, `serverLines(this.bundle)`) and, when this machine has a
  copy, runs `receivePatch` against it into `incoming/`; it falls back to the whole file when there is no copy or the
  patch fails, as the phone's `download` does, and places the result as today. `ServerConversation` takes the bundle
  name, which `main.ts` has.

The source's side needs nothing new: its `diff` command and released database are what the phone's `receivePatch`
already uses.

## Ownership and lifetime

The patch's temporary files on the source are the target's to remove (`discardPatch`, as the phone's); the
downloaded patch is removed with the move's `finally`. The target's copy is replaced only by a verified result.

## Deviations

None. The target keeps no copy fresh between moves, as the phone does for its own: a patch carries every page
changed since the target last held the conversation, which is still a fraction of the file.

## Size

~150 lines moved, ~50 changed or added. The server bundle changes: both servers reinstall at the next connect, and
the phone needs a Release install for the same bundle.

## Checks

- Move InfiniChat from this Mac to vikash-system and back, with both machines holding a copy from today: each move's
  copy step shows the patch's size, not 92 MB, and finishes in seconds; `incoming` matches what the source named.
- A target without a copy (its `copy/` removed) falls back to the whole file.

## As built

From `de45841` on `feat/mac-app-shell` (2026-10-28), one commit. What differs from the plan:

- **`transfer.ts` owns the folder names** (`FOLDER`, `DATA`, `INFINICHAT_DATABASE`) with the transport; `move.ts`
  imports them and re-exports `INFINICHAT_DATABASE`. `Copy.transfer` names the downloaded patch on each side.
- **The server's patched file was world-readable.** `nodeDatabaseFiles.write` used `writeFile`'s default mode, so the
  result of `apply` on vikash-system landed 0664; it writes 0600 now, as the whole-file path always did, and the file
  there was tightened by hand. A second bundle followed.
- **The pull's signal is the context's**: `Context.abortSignal`, or one that never fires.

Verified on 2026-10-28: a move from this Mac to vikash-system, both holding a copy from earlier that day, finished
in seconds where the whole file had taken minutes; vikash-system's server was reinstalled from the new bundle by the
move, `incoming/` was clean afterwards, and the adopted database matched what the Mac named. Not verified: the move
back with a patch, and the fallback for a target without a copy.
