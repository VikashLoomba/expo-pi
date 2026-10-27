# Piece 4: Install and move

## Goal

The logic of moving InfiniChat, of the home record and of installing the server moves into the package. It acts on
machines through pi-durable's `ExecutionEnv`, and each app supplies the rest of the primitives it runs on. The iPhone
keeps working as today. The Mac app can then install the server, on other machines and on itself, and move InfiniChat
with the same code.

## Owner decision (2026-10-26)

Install and move act on machines through pi-durable's `ExecutionEnv`, not an app-defined interface.

## Starts from

What the three files do today, and which parts depend on the host:

| File | Host-neutral | Host-specific |
| --- | --- | --- |
| `move.ts` (714 lines) | `InfiniChatMoves` (`:386`): phases, Cancel and undo, resume, refresh, `bringBack`; `MoveSides` (`:52`); the patch and whole-file orchestration of `upload` (`:293`), `download` (`:330`), `sendPatch` (`:242`), `receivePatch` (`:261`), `refreshCopy` (`:357`); the script constants | react-native-ssh connections and shells; `downloadFile` (`:158`) and `fetchBytes` (`:226`), which stream `cat` after a marker into an expo-file-system `File`; the file helpers `phoneFile`, `describe`, `fold`, `remove`, `rename` (`:66-117`) over expo-file-system and expo-sqlite; the `phone` `PagePlatform` (`:119`) over expo-crypto and nitro-zlib; `backupDatabaseAsync` |
| `install.ts` (410 lines) | `installServer` (`:309`), `runningServer` (`:403`), `detect`, the launchd, systemd and readiness scripts, `readyPort`, the messages | `connectAdmitted` (`:274`) and `runScript` (`:78`) over react-native-ssh (`runSshCommand`); the secret in expo-secure-store with expo-crypto random bytes (`:99-120`); `loadServerBundle` and `loadPackagedDaemon` over expo-asset |
| `home.ts` (56 lines) | `parse`, the store's subscribe and set | expo-sqlite kv-store's synchronous get and set |

`pages.ts` is already in the package (piece 2) with its `PagePlatform` seam (`pages.ts:12`), and
`server/pages.ts` already implements it for Node.

## Why `ExecutionEnv`

Install and move do a few things on another computer: they put a file there, check it, rename it, run a shell
script, and read a file back. Today that code calls react-native-ssh directly. To share it with the Mac, it needs an
interface for "a computer's files and commands" that the phone and the Mac each implement. pi-durable already defines
one, `ExecutionEnv`, so the app uses it instead of inventing its own:

```ts
// Today: a script with the bytes on stdin, over react-native-ssh
await runScript(connection, signal, name, ['t=$(mktemp …)', 'cat > "$t"', `[ "$(hash "$t")" = ${sha256} ]`,
  'mv -f "$t" "$f"'], { failure, input: bytes });
// With ExecutionEnv: the same steps as file operations and a command
await machine.writeFile(temporary, bytes, context);
await machine.exec(`[ "$(hash ${temporary})" = ${sha256} ] && mv -f ${temporary} ${file}`, undefined, context);
```

Why it is the idiomatic choice:
- **AGENTS.md: "Don't re-create what pi-durable … already provide[s]."** An app interface would be a second one for a
  computer's files and commands, next to pi-durable's.
- **pi-durable uses that interface beyond tools.** Its JSONL storage opens on any `FileSystem`
  (`JsonlStorage.open(directory, fs, …)`, `dist/storage/jsonl/storage.d.ts:27`; `README.md:790`).
- **Upstream's own session sync uses it to move sessions.** The unreleased sync on the `replication` branch includes
  `FileSystemSyncRemote(fs: FileSystem, root)`, a sync remote kept in a folder on any pi-durable `FileSystem`
  (`packages/durable/src/sync/filesystem.ts` at `f6f3d5507`, 2026-10-24). Its own comment says "for development and
  tests, with one process writing". A `RemoteExecutionEnv` is such a `FileSystem`.
- **pi-env exists to provide this interface on another machine over SSH,** and the phone already ports it.

This is still not pi-durable's real answer to moving a conversation. That answer is session sync, which is
unreleased. The copy stays behind one seam that sync can replace.

## Builds

### Machine work through `ExecutionEnv`

The calls `ExecutionEnv` offers (pi-durable `dist/env/index.d.ts:164-302`) replace today's SSH helpers:

| Today | With `ExecutionEnv` |
| --- | --- |
| `runScript`: one POSIX script over SSH; the answer is what follows the marker | `exec(script)`, collecting stdout through `onOutput`; keep the marker parsing |
| Input on the script's stdin: uploads, the secret, the plist or unit, page lists | `exec` has no stdin (`ShellExecOptions`), so write the input first with `writeFile` or `appendFile` to a temporary path inside `~/.infinichat`, and the script reads it there |
| `downloadFile`: `cat` after a marker, streamed into a local file | `openBinaryReader` on the machine's file, written to the local file in chunks; `readBinaryFile` for small files such as page lists |
| `connectAdmitted` and `reconnected` for each copy | The environment's own connection, which starts again by itself after a loss (pi-env `dist/connection.d.ts:69-70`) |

Which environment each app passes:

| App | A configured machine | Itself |
| --- | --- | --- |
| iPhone | `remote.environment(machineId, undefined)` from `owner.ts` (`MobileRemoteExecutionEnv`) | — (the phone runs no server) |
| Mac | pi-env `RemoteExecutionEnv` over `connectSsh` | `NodeExecutionEnv`: the same install code installs the server on the Mac it runs on |

What goes away: the marker streaming (`downloadFile`, `fetchBytes`, `COPY_MARKER`), the workaround for
react-native-ssh's 16 MiB `exec` output cap, and `reconnected`. The daemon already discards whatever shell startup
files print before its sync line (pi-env `docs/protocol.md`, "Sync").

The daemon's own installation stays raw SSH. pi-env's `deployDaemon` does the same, and on the phone
`remote.environment` installs it as the tools do (`provisioning.ts`).

Design checks before implementing:
1. **Input files and permissions.** `writeFile` takes no file mode. Write inputs only inside `~/.infinichat`. Today's
   install creates it under `umask 077`, and the server creates it with mode `0700` (`server/main.ts`), so other
   accounts can't read what's inside whatever the files' own modes. Create the folder with the first `exec`, before
   any `writeFile`. The secret's final file keeps the script's `chmod 600`.
2. **The server must outlive the daemon.** pi-env's `close()` stops the daemon, which "kills everything it started"
   (`dist/connection.d.ts:80`), and aborting an `exec` "kills only this command's processes" (pi-durable `Shell.exec`).
   `launchctl` and `systemctl --user` return after handing the server to launchd or systemd, exactly as they do
   inside today's SSH session that ends. Verify that the server survives closing the daemon connection.
3. **Login shell.** The scripts find Node through the account's login shell (`detect`), and the service starts through
   `<shell> -lc` (decided 2026-10-22). Both stay in the scripts, so they don't depend on how `exec` runs them.
4. **Large files.** pi-env frames are at most 16 MiB, and "larger transfers are split by the client" (`protocol.md`).
   Check that the phone's port splits the same way. `appendFile` in chunks keeps the progress that `onWritten` reports
   today.
5. **Timeouts.** Keep today's values: no timeout for copies, 60 s for other steps (pi-env's SSH step timeout), 300 s
   for uploads during install.
6. **Cancellation.** Each operation takes a `Context` whose signal the move or install controls. Cancelling kills the
   running command, never the connection, which isn't theirs.
7. **Ownership on the phone.** `client.ts` says today that "the tools' daemon connections in owner.ts are not used
   while the machine runs InfiniChat". Now a move or install borrows `owner.ts`'s connection for that machine, which
   stays open until the provider closes the owner. That is pi-env's pattern, one connection per machine shared by its
   environments, and the chats' connections already work this way.

### The local database: `PagePlatform` extended

The local side of a move is always the database's own files. Extend `PagePlatform` instead of adding a second
interface:

```ts
export interface DatabaseFiles extends PagePlatform {
  /** SHA-256 and size, or undefined when the file isn't there. */
  describe(name: string): Promise<ConversationFiles['db'] | undefined>;
  /** `PRAGMA wal_checkpoint(TRUNCATE)` on the closed database; fails when it is still in use. */
  fold(name: string): Promise<void>;
  /** SQLite's backup API, from the open database to `to`, at the same page numbers. */
  backup(from: string, to: string): Promise<void>;
  /** Over `to`, removing both names' `-wal` and `-shm`. */
  rename(from: string, to: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Where a download writes. */
  open(name: string): Promise<WritableStream<Uint8Array>>;
}
```

- **iPhone:** `move.ts`'s helpers and `phone`, in expo-sqlite's database folder.
- **Node (piece 5):** `node:sqlite` and `node:fs`, from `server/conversation.ts` (`fold`, `describe`) and
  `server/pages.ts` (`backup`), in the app's data folder.

The file names (`infinichat.db`, `-moved`, `-incoming`, `-backup`, `-transfer`) stay package constants.

### The home record

`createInfiniChatHome(store)`, with a synchronous `{ getItem(key): string | null; setItem(key, value): void }`. The
writes must stay synchronous: each phase is saved before the step that needs it (`home.ts:37-38`). The iPhone passes
expo-sqlite kv-store's `getItemSync` and `setItemSync`.

The stored `home: 'phone'` keeps its spelling: it is stored data. Read it as "this device". The record that every
client can read, saying which side holds the conversation, is piece 7's.

### Secrets and assets

- **Secrets:** `savedSecret`, `machineSecret` and `forgetSecret` take a `CredentialBackend` (piece 1) and a
  `randomBytes(count)`. iPhone: expo-secure-store and expo-crypto. Node: the framework's keychain and `node:crypto`.
- **Assets:**
  `ServerAssets { manifest; bundle(signal): Promise<Bytes>; daemon(platform, signal): Promise<{ bytes; sha256 }> }`.
  iPhone: `server-assets.ts`, `daemon-assets.ts` and the generated manifests, which stay in the app. Mac: files among
  its resources, and pi-env's `packagedDaemon()`.

### `InfiniChatMoves`

The constructor takes the home store, a `MachineDirectory` (piece 3), a function returning a machine's
`ExecutionEnv`, `DatabaseFiles`, `MoveSides`, and the local device's name for messages. Its user-visible copy names the
device ("this iPhone" today), so that name comes from the app.

`MoveSides` (`move.ts:52`) is already the seam to the provider. It moves with `closePhone` and `openPhone` renamed to
`closeLocal` and `openLocal`, since on the Mac the local side is no phone. They are code names, not stored data.

### What stays in the iOS app

The phone's `DatabaseFiles`, the kv-store adapter, the secret and asset adapters, and the provider wiring in
`chat-provider.tsx` and `remote-hosts/index.tsx`. The SSH helpers that only install and move used go away.

## Ownership and lifetime

- **InfiniChatMoves:** created and closed by the provider, as today. It borrows the home store, the machine directory,
  `DatabaseFiles` and `MoveSides`.
- **Machine environments:** borrowed from the owner of the machines' connections: `owner.ts` on the phone; on the Mac,
  a machines owner that holds pi-env connections and closes them at shutdown, as `ServerMachines` does.
- **Cancellation:** a move's `AbortController` reaches every operation's `Context`. Cancel and close abort it; neither
  closes a borrowed connection.

## Deviations (need approval)

- `RemoteHostRepository` leaves `InfiniChatMoves` and `installServer`, as it leaves RemoteInfiniChat in piece 3.

Borrowing `owner.ts`'s connection (check 7) is not a deviation: it is pi-env's pattern and how the chats already use
those connections, and nothing users see changes.

## Size

About 1,180 lines move, most of them unchanged: the scripts and the move logic. The marker streaming and the reconnect
code should go, about 100 lines, and the phone's adapters add about as many.

## Checks

- Lint, typecheck, server typecheck; rebuild the server asset and run `--check`.
- On the iPhone Release install, with the database backed up:
  - A server install: a new bundle from the rebuilt asset, so the phone updates the machine's server.
  - The server keeps running after the phone closes its connection to the machine.
  - Move to vikash-system and back, with a page patch: the machine has a copy from the last move back.
  - A move that sends the whole file: the first move to a machine with no copy.
  - Cancel while copying: the conversation stays where it was.
  - Force-quit the app during a move: the next launch carries the move on.
  - The refresh at app activation: the phone's moved copy is byte-identical to a fresh snapshot of the machine's
    database, as piece 8 of `docs/server-harness-toggle` checked.

## Not in this piece

The Node implementations (piece 5), the server's single-client code (piece 7), and moving InfiniChat directly between
two machines.

## As built

Built in the commit that adds this section, from `68f1d9b`, with pi 1.4.0 (pi-durable, pi-ai, chord and pi-env; still
the latest on npm on 2026-10-26), Expo 58.0.17, React Native 0.88.0, react-native-ssh 0.3.0 and pnpm 10.33.0. Read
again at the installed versions: pi-durable `dist/env/index.d.ts` (`FileSystem`, `Shell.exec`: no stdin, an abort
kills only that command's processes), chord `dist/context/index.d.ts` (`withAbortSignal`, `awaitWithContext`), pi-env
`dist/connection.d.ts:69-80`, `docs/protocol.md` ("Frames", "Liveness", `exec`), `docs/semantics.md` ("Commands": a
string runs through `bash -c`, each command in its own process group, killed with SIGKILL on abort or timeout),
`dist/remote-env.js:13-17` (read and write chunks) and `dist/ssh.js:85-86`, `:309-322` (step timeouts, `quotePosix`,
the hash function). The doc names no steps, so it is one commit. `git` records `home.ts` as a rename; `install.ts` and
`move.ts` changed too much for its rename detection and show as removed and added.

| File | Lines |
| --- | --- |
| `packages/infinichat/src/pi/infinichat-remote/move.ts`: `InfiniChatMoves`, `MoveSides`, `DatabaseFiles`, the copies | 646, from 714 |
| `packages/infinichat/src/pi/infinichat-remote/install.ts`: `installServer`, `runningServer`, `ServerAssets`, the secrets | 391, from 409 |
| `packages/infinichat/src/pi/infinichat-remote/home.ts`: `createInfiniChatHome(storage)` | 58, from 56 |
| `packages/infinichat/src/pi/infinichat-remote/machine.ts`: `runScript`, `quotePosix`, `HASH`, temporary files | 90 |
| `apps/mobile/src/pi/infinichat-remote/phone-files.ts`: the phone's `DatabaseFiles` | 80 |
| `apps/mobile/src/pi/infinichat-remote/phone-home.ts`: the kv-store adapter | 8 |
| `apps/mobile/src/pi/infinichat-remote/server-assets.ts`: `phoneServerAssets`, `SERVER_BUNDLE` | 38, from 25 |
| `apps/mobile/src/pi/infinichat-remote/phone-dialer.ts`: now with `connectAdmitted`, which only it uses | 147, from 110 |

Together 1,458 lines where there were 1,314, against the plan's "about as many": the marker streaming and the
reconnects went (about 90 lines), and the seams' interfaces (about 65), the chunked copies (about 50) and the install
upload's three steps took their place. The review's fixes added about 25 (the connection owner's `lost` test and the
removal of the page commands' own files); the daemon channel's queue (below) adds 32 lines to `channel.ts`. The second
round's fix (a daemon that fails to start is a lost connection, below) takes 6 lines out of the remote port.

What differs from the plan:

- **The server bundle doesn't change, so nothing reinstalls.** The server imports none of the moved files, and the two
  comments changed in `server/listen.ts` and `server/pages.ts` don't reach esbuild's output: the asset rebuilt here is
  byte-identical (8,352,831 bytes, SHA-256 `668a9eec…3cecff`). The first device check needs an install forced by hand
  (below).
- **The dial's check for a running server goes through owner.ts's environment too.** The doc's table makes
  `runningServer` host-neutral, and it ran over the dial's SSH connection, so it now takes the `ExecutionEnv`, as the
  install does. The dial's own SSH connection carries only the tunnel. A machine used only for InfiniChat gets the
  phone's pi-env daemon (`~/.pi/mobile/tools/`) at its first connect, as a chat's tools would deploy it there.
- **`InfiniChatMoves` takes a function from a machine's ID to its `MachineDirectory`, and the bundle.** Piece 3 made a
  directory one machine's (it has an `id`), and moves serve whichever machine they move to; they use only `name()`.
  The server lines of the page commands need the bundle's folder name (`serverBundle`), which the doc's list lacks.
  After the environment comes the owner's `lost` test (see "Messages"). The arguments are positional, as they were,
  with `MoveSides` last.
- **`installServer(target, assets, secret, options)`.** `InstallTarget` is the machine as the app knows it: its
  `ExecutionEnv` and its owner's `lost` test, name, `machineDescription` and SSH account (the linger advice names it).
  The dialer gets the secret from `machineSecret(credentials, getRandomBytesAsync, machineId)` first, where
  `installServer` used to.
  `ServerAssets.manifest` carries each daemon's SHA-256 as well as the bundle's, because the install checks the
  machine's copies before loading any asset (from `PI_DAEMON_MANIFEST` before).
- **A step's input is a file the package names and removes.** `writeFile` puts it at a unique name (`temporary`, pi-ai's
  `uuidv7`, where `mktemp` named one), and `discard` removes it however the step ended: a cancelled or timed-out command
  dies with its process group by SIGKILL, so its `trap` never runs. The removal isn't awaited, so a lost connection
  doesn't hold up the step's failure while it waits for a new one. A force-quit, or a connection that stays lost, leaves
  that one file in `~/.infinichat` (a page list, a patch, an upload or a service file); today's scripts removed theirs
  on SIGPIPE or SIGHUP. The page commands write files of their own: `node.write` puts `<file>.<pid>` beside its output
  and renames it, and `diff --live` backs the database up to `<patch>.<pid>.db` (`server/pages.ts`). A stopped command
  never runs its `finally`, so a patch step removes those with its own files, in one `rm -f` of the step's names and
  their `.*` (the page list and the patch, and the aside of the output it applied), and a refresh stopped as the app
  goes to the background leaves nothing; the server bundle doesn't change for it. A move's whole-file upload is written
  straight to `data/incoming/infinichat.db` and verified there (SHA-256, then `chmod 600`) before the place step moves
  it, so a cut-off upload leaves only that file, which the next copy replaces; the old `.upload.XXXXXX` beside it is
  gone. Install uploads keep a file beside the final name, renamed into place once verified.
- **Folders exist before anything is written into them (design check 1).** `writeFile` makes missing folders with the
  environment's default mode, so every write follows a command that made its folder under `umask 077`: an install
  upload makes its own folder first (and so `~/.infinichat`, 0700), the secret and service files go into
  `~/.infinichat` after the bundle is there, a move's page lists and patches are written only after a command found the
  server's bundle (`receivePatch` got one round trip of its own for that), and the whole-file upload makes
  `data/incoming` first. Uploaded files are `chmod 600`, as `umask 077` made them before; service files keep the
  default mode, which launchd and systemd accept.
- **The sshd workarounds are gone.** `ON_SIGNAL`, `TICK`'s newline each second (now `sleep 1`) and the scripts' traps
  for their temporary files guarded against sshd leaving a script running after its channel closed; pi-env kills the
  command's process group on abort, timeout and a lost connection. `exec` runs a string through `bash -c` (or `sh`), so
  `script()`'s `sh -c` wrapper went too; the scripts are POSIX.
- **The 300 s upload timeout is a deadline on the write.** `writeFile` takes no timeout, so the context aborts after
  `UPLOAD_TIMEOUT_MS` (`AbortSignal.timeout`, which React Native 0.88 has); the verify-and-rename command keeps 60 s.
  Copies have none, other commands 60 s, as before.
- **The install reports `checking` after detecting the system.** `connecting` is reported before the first command.
  On the phone the environment has already connected by then (owner.ts's `environment` awaits `connection.info()` for
  the cwd, and the client's stageless `connecting` keeps "Connecting to …" on screen meanwhile); pi-env's
  `RemoteExecutionEnv` connects at that first command. The screen shows "Connecting to …" for `connecting` and
  `checking` alike.
- **`TRANSFER` stays**, as the local file a downloaded patch goes through (`DatabaseFiles.open`). `DatabaseFiles.fold`
  does nothing when the database isn't there, the check `phoneFiles` made before folding, since opening would create it.
- **Messages.** The device's name in the moves' messages comes from the app ("this iPhone"), capitalized where a
  sentence starts with it ("This iPhone has no InfiniChat conversation to move.", "Choose This iPhone to move it
  back."). The install's linger advice keeps "this phone", as piece 3 kept "did not accept this iPhone"; the Mac's
  piece can reword it. A command that fails to run maps to the same fixed connection message as before. A file
  operation maps to it when the environment's owner says the connection was lost, and on `aborted`, which, once the
  caller's own signal is checked, is the install upload's 300 s deadline, as the old `TIMEOUT` was; every other code,
  `unknown` included, maps to the step's own message ("… home folder permissions and disk space" for a full disk, as
  the script-based upload reported it). The code can't tell: `unknown` is also every system error the environment
  doesn't map (pi-env `dist/errors.js`, `toFileError`), and pi-env marks a lost connection on the `RemoteError` the
  `FileError` keeps as its cause (`lost: true`, `isConnectionLost`). So `InstallTarget` and `InfiniChatMoves` take a
  `lost(error)` test from the connection's owner; the phone's is `remote.lost` in `owner.ts`,
  `isConnectionLost(error.cause)` over the port's own `isConnectionLost`, and the Mac's would be pi-env's. A failed
  read in a download keeps "The SSH connection closed before the copy was complete." Remote text never reaches one.
- **A daemon that fails to start is a lost connection on the phone too.** pi-env marks every failed start `lost: true`
  (`dist/connection.js:198-200`, `:213-215`: a failing `command()`, a spawn error, an early exit, the start timeout),
  and `docs/protocol.md` ("Liveness") fails a lost connection's requests with `{ code: "unknown", lost: true }`. The
  port's `Connection` rejected a failed start with the SSH or setup error itself, so a file operation that was the first
  to find the connection gone, and couldn't reconnect, showed the step's message. Its `#start` now rejects with a
  lost-marked `RemoteError` (code `unknown`) that carries that error's message, so whatever shows the message shows
  the same text, and keeps the error itself as the `cause`. What follows:
  - The Remote machines test reads the cause's code, so its messages are the same as before.
  - The port's `toFileError` loses its two `BootstrapError` branches and now matches pi-env's. A setup failure no
    longer reaches it directly, and a cancelled setup never did: `Connection` aborts a start only while tearing it
    down, and that teardown's error has already settled the start. A chat on a machine the setup doesn't support gets
    `unknown` instead of `not_supported`, with the same message, as pi-env reports it.
  - The folder picker shows a `FileError`'s message without looking at its cause. A failed start's message is the
    channel's sanitized SSH text or the app's own, as the picker already showed when `environment()` failed.
  - The remote watcher (`watch.ts`, pi-env's `RemoteWatcher`) keeps retrying while the machine can't be reached, as
    pi-env's does. Before, its first failed restart ended it with an error.
- **The phone's SSH helpers shrank back.** `quotePosix` and `HASH` are the package's own in `machine.ts`, as pi-env
  keeps its own in `ssh.ts` and the port its own in `provisioning.ts`. The exports only the install used (`HASH`,
  `script`) are private again, and `runSshCommand`'s `onWritten` and `null` timeout, which only the moves used, are
  gone: `command-channel.ts` is byte-identical to its version before the move feature (`f9f8f2e~1`).
- **The daemon channel queues what react-native-ssh refuses.** The bulk uploads now share owner.ts's daemon
  connection with the chats' tools, and the port's write pipeline keeps eight 512 KiB chunks in flight, so a second
  writer on that connection could fill react-native-ssh's shell write queue. It refuses a write then (`QUEUE_FULL`,
  accepting none of the bytes), and `Connection` tore the whole session down on any throw from `write`, failing every
  request on the machine. pi-env's client writes to its daemon's stdin, which keeps in memory what the daemon hasn't
  read, so `createSshChannelFactory`'s `write` now does the same: a refused frame waits in order in JavaScript and is
  offered again every 10 ms, as `command-channel.ts` retries its writes. Only a failed channel throws.

Choices:

- The shared helpers for scripts and files are in `machine.ts`, which `install.ts` and `move.ts` both import.
- A copy reads and writes 4 MiB per call between progress reports, so each call keeps upstream's pipeline full (512 KiB
  writes and 256 KiB reads, eight in flight).
- Getting a machine's environment in a move or a dial goes through chord's `awaitWithContext`, so a Cancel stops waiting
  for owner.ts's connection, which the owner keeps.
- The phone's adapters: `phone-files.ts` (expo-file-system, expo-sqlite, expo-crypto, nitro-zlib), `phone-home.ts`
  (expo-sqlite kv-store's `getItemSync` and `setItemSync`), `phoneServerAssets` beside `loadServerBundle`, and the
  secrets straight from `createCredentialBackend()` and expo-crypto's `getRandomBytesAsync`.
- `MoveStatus.to` keeps `'phone'`, read as "this device" like the home record's; it is internal, so piece 7 or the Mac
  piece may rename it.
- The provider still doesn't await `moves.close()` before closing owner.ts's connections at teardown: a move can be
  waiting on a step queued behind that teardown, so awaiting it would deadlock. Closing aborts the move first; a
  request still in flight then fails with the closed connection, which leaves what a stopped move leaves.
- Nothing stored is renamed, so no app data needs clearing and nothing migrates.

Design checks:

1. Input files and permissions: as above. The install probe below found `~/.infinichat` 0700 and the bundle and secret
   0600.
2. The server outlives the daemon: launchd and systemd own the server. For the detached start, pi-env's local daemon on
   this Mac left both a background job and a new session's process running after `Connection.close()`; macOS has no
   `setsid(1)`, so the Linux line itself wasn't run.
3. Login shell: `detect` and the service's `<shell> -lc` stay in the scripts.
4. Large files: the phone's port splits as upstream does (`environment.ts` writes 512 KiB, eight in flight;
   `readers.ts` reads 256 KiB, eight in flight; pi-env `dist/remote-env.js:13-17` the same), below the 16 MiB frame.
5. Timeouts: as above.
6. Cancellation: every operation takes the move's or the dial's signal through a `Context`; nothing closes a connection.
7. Ownership: moves, installs and the running-server check borrow owner.ts's connection; `phone-dialer.ts` and
   `owner.ts` say so.

Checks:

- From `apps/mobile`: `npx @expo/agent-cli lint` (exit 0; `npx expo lint -- --max-warnings 0` clean, 95 files),
  `npx @expo/agent-cli typecheck` (no type errors) and `pnpm exec tsc -p server` (no errors). From the root:
  `pnpm --filter @pi-agent/infinichat lint`, 42 files, no problems besides the known warning that React can't be
  detected; the guard passes, so none of the moved files imports a host module.
- The server asset, rebuilt in this checkout: byte-identical, as above; `--check` passes.
- An iOS export with source maps bundles the four package files and the four phone files, with one store directory
  each for chord, pi-ai, pi-durable and pi-telemetry.
- Probes in the session scratchpad, not committed, bundled with esbuild and run on Node 25.6.1 against pi-env 1.4.0's
  own `RemoteExecutionEnv` over `localDaemon()` on this Mac, in a scratch `HOME` holding the rebuilt server bundle:
  - `runScript`: the answer after the marker, a failing script's message, a timeout's message, and an abort rejecting
    within about 300 ms.
  - `InfiniChatMoves` with Node `DatabaseFiles` and a stand-in client: a move there with no copy (whole file, progress
    4,194,304 then 4,571,136 of 4,571,136 bytes), a refresh while there, a move back by patch, a refresh of the copy
    from a live backup, and a move there by patch, each leaving the two sides byte-identical; a Cancel while copying
    leaving the conversation on this device and nothing placed; no temporary files left afterwards.
  - `installServer` with a stand-in `launchctl` that starts a stand-in server: the first install uploads the bundle and
    four daemons and starts the service, a second one uploads nothing and restarts nothing, a new secret kickstarts it,
    a Cancel during the upload rejects with an `AbortError`; no temporary files left afterwards.
- After the review's fixes, all of the above again (lint, typecheck, server typecheck, the asset still byte-identical
  with `--check` passing, the iOS export with the same files and store directories, the install probe with its `lost`
  test), and a probe of the fixes against a 234,651,648-byte machine database:
  - A refresh while the machine holds the conversation, stopped while the server's `diff --live` had
    `.patch.<uuid>.<pid>.db` and its `-journal` open: nothing left in `~/.infinichat` and the moved copy unchanged; at
    `99682cb` the same run left both files. A refresh that completes leaves the moved copy byte-identical to a fresh
    backup of the machine's database.
  - A refresh of the machine's copy, stopped while the `patch` command was writing `copy/infinichat.db.<pid>`: no
    aside left; one that completes leaves the copy byte-identical to a backup of this device's database.
  - `fileFailure` with pi-env's `isConnectionLost(error.cause)`: removing a folder that isn't empty (`unknown`) gives
    the step's message; a 512 MiB write cut by killing the daemon (`unknown`, the cause marked lost) and a write past
    its deadline (`aborted`) give the connection message; a cancelled write throws the `AbortError`.
- After the second round's fix: lint, typecheck, server typecheck, the iOS export with the same files and store
  directories, and `--check` passing on the unchanged asset (the server imports none of the changed files). A probe of
  the port's `Connection` with a stand-in channel, bundled with esbuild and run on Node 25.6.1 (expo-crypto's
  `getRandomValues` from Node's): a start failing with an SSH error (`CONNECT`) or a `BootstrapError` rejects with a
  lost `RemoteError` that carries its message and keeps it as the `cause`; `toFileError` gives `unknown` with that
  message and the owner's `lost` test is true, so `fileFailure` gives the connection message; the next request starts
  again; a daemon's `ENOENT` and a closed connection aren't lost; a watcher whose connection drops keeps retrying while
  restarts fail and reports `overflow` once one succeeds. At `f0d08b8` the same probe got the SSH error itself, not
  lost, and the watcher ended with an error at its first failed restart.

Unverified: nothing ran on a device, nothing ran over SSH to a real machine, and the systemd and detached paths ran
nowhere. By source assessment only: the phone's port in place of pi-env's client, the first connect after a long
background (owner.ts's daemon connection has to notice it was lost before the dial's check uses it; its silence timer
does that at the first tick after the app resumes), a force-quit's leftover file, the daemon channel's queue for
`QUEUE_FULL` (react-native-ssh doesn't run in Node), and the phone's `remote.lost` (Hermes keeping `FileError`'s
`cause`, which `client.ts` already relies on for Chord's errors), and the port's failed start marked lost with real
SSH and setup failures (react-native-ssh doesn't run in Node; the `cause` is an own property set by `Object.assign`,
so it doesn't depend on Hermes supporting `Error`'s `cause` option). Device checks, on the iPhone Release install with
the database backed up:

- A server install: the bundle is unchanged, so force one: on vikash-system stop the service
  (`systemctl --user stop infinichat`) and remove `~/.infinichat/server/<bundle>`, then open InfiniChat. The phone
  uploads the bundle and starts the service, and the transcript appears.
- The server keeps running after the phone closes its connection to the machine (background the app for a minute, or
  force-quit it, then check `systemctl --user status infinichat`).
- Move to vikash-system and back, with a page patch; a move that sends the whole file (the first move to a machine with
  no copy); Cancel while copying; force-quit during a move, then relaunch; the refresh at app activation leaving the
  phone's moved copy byte-identical to a fresh snapshot of the machine's database.
- Return to the app after more than a minute in the background with InfiniChat on vikash-system: it reconnects without
  showing a failure.
- With InfiniChat on vikash-system, return to the app and send it to the background again within a second or two,
  while the refresh's `diff --live` runs, a few times.
- During a move there that sends the whole file, have a chat whose tools run on vikash-system write a file of a few
  MiB: both finish, and neither shows a lost connection.
- With Tailscale off during a move's copy, the move's failure names the connection ("Check Tailscale"), not disk space.
- In Remote machines, test vikash-system with Tailscale off: the message names Tailscale, as before the failed start
  was marked lost.
- After those, `ls -a ~/.infinichat ~/.infinichat/data/incoming ~/.infinichat/copy` on the machine shows no `.pages.*`,
  `.patch.*`, `.secret.*` or `.service.*` files and no `infinichat.db.<pid>` asides, except after a force-quit
  mid-copy.
