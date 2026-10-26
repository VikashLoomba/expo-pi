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

`MoveSides` (`move.ts:52`) is already the seam to the provider and moves unchanged. Renaming `closePhone` and
`openPhone` to local-sounding names is optional.

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
