# References

Checked on 2026-10-21. Versions:
- **pi:** 1.3.0 installed; the target is 1.4.0, published to npm at 22:44 UTC that day (tag `4a080252f`).
- **App:** Expo 58.0.14, React Native 0.88 with Hermes 260318099.0.4, react-native-ssh 0.3.0.

`file:line` references are at those versions unless stated otherwise.

## Upstream contracts

| Contract | Source |
| --- | --- |
| A Chord server host owns the Durable Harness; clients get a reference | chord `docs/guide.md:756` "Durable", `:712` "Hosts and links" |
| A `Chat` object exposing `view`, `send`, `stop` per principal | chord `docs/guide.md:367` |
| Mirroring an external store into a cell with `replace`, sent as a diff | chord `docs/guide.md:444` |
| A held reference keeps its last values while a link reconnects; calls wait until live | chord `docs/guide.md:396` "References" |
| `host.connect(link)` replaces the link after a reconnect | chord `src/host.ts:231` |
| Links don't resume: a dropped link releases its holds, re-holds are new | chord `docs/spec.md:260` |
| `acceptWebSockets` hard-codes `compress: true` | chord `src/websocket.ts:26` |
| Payloads over 64 KiB are deflated; browsers inflate with `DecompressionStream` | chord `src/link.ts:113`, `:229` |
| `Link` interface | chord `src/link.ts:5-18` |
| `processLock`: kernel-owned, taken before opening storage | chord `src/manager.ts:76-82` (`@earendil-works/chord/node`) |
| One process owns a storage; no cross-process locking | pi-durable `README.md:790` |
| Work interrupted by a crash or close stays pending | pi-durable `README.md:127` |
| A clean close writes stopped tasks back as pending, uncounted | pi-durable `CHANGELOG.md:22` (1.4.0) |
| `watch()` is meant for remote clients; a late joiner starts from the current view | pi-durable `README.md:495` |
| `HarnessOptions.models`: a `Models` or a function returning one | pi-durable `src/harness/types.ts:616` |
| Host-injected `CredentialStore`; refresh serialized inside `modify` | pi-ai `README.md:456` |
| `models.login` with a relayed `prompt`/`notify`; `manual_code` races the local callback | pi-ai `README.md:1785`, `:1808` |
| Credentials stay with the Durable worker | pi-env `README.md:4` |
| `connectSsh`, `sshConnection`, `scanHostKey`, `acceptHostKey`, `binary` | pi-env `src/ssh.ts:355-359`, `:464-472`, `:519-532` |
| Node ≥ 22.19 and built-in `node:sqlite` | pi-durable and chord `package.json` `engines`; chord `src/sqlite/node.ts:3-4` |
| Member names a contract may not use (`status`, `error`, `variant`, …), at v1.4.0 | chord `src/contract.ts:178-189` |
| No `undefined` anywhere in state; it is not dropped as `JSON.stringify` drops it, at v1.4.0 | chord `src/delta/README.md:115-119` |
| A link close aborts the calls that came over it, at v1.4.0 | chord `src/connection.ts:1230-1240` |
| A method's error crosses as `{ code: "unavailable", message }`, prefixed again on the client, at v1.4.0 | chord `src/wire.ts:171-181`, `src/errors.ts:36` |
| A single-file bundle reads its own copy of Photon's WebAssembly for `createPhotonImages`, at v1.4.0 | pi-durable `src/images/node.ts:24-25` (`dist/images/node.d.ts:17-19`) |
| Closing the Harness closes its storage, at v1.4.0 | pi-durable `src/types.ts:1075` |
| Local port forwarding for WebSocket clients | react-native-ssh `README.md:16-20`, `:87-93`; `src/index.ts:146-156` |
| `exec` output is capped at 16 MiB; `exec` has no stdin | react-native-ssh `src/errors.ts:20`, README "Planned" |
| `WebSocket(url, protocols, { headers })` | react-native `Libraries/WebSocket/WebSocket.js:100` |
| `deployDaemon`: check by SHA-256, upload to a temporary file, verify, rename, at v1.4.0 | pi-env `src/ssh.ts:389-398`, `:400-461` |
| `loginShell`: start the daemon through `exec "$SHELL" -lc 'exec "$0" "$@"'`, at v1.4.0 | pi-env `src/ssh.ts:466-470`, `:475-484` |
| A child host's `readyTimeout` defaults to 30 s, at v1.4.0 | chord `src/manager.ts:238-239`, `:325-327` |
| `processLock` is a socket file under `os.tmpdir()` on macOS, an abstract socket on Linux, at v1.4.0 | chord `src/manager.ts:82-91`, `:133-134` |
| Node ≥ 22.19 | pi-durable `package.json` `engines` (installed 1.4.0, line 150) |

## Chord over WebSocket in Hermes

**Probe, 2026-10-21.**
- **Server:** a Node 25 process with a Chord host and a real pi-durable 1.3.0 Harness (faux model) serving the root
  conversation's view with `send` and `stop`, mirroring the view into a cell as piece 1 does.
- **Client:** the same contract in the running app's Hermes runtime (simulator, dev build).
- **Not committed:** the probe was scratch code.

| Check | Result |
| --- | --- |
| Chord's host, link and WebSocket modules in the app bundle | Already bundled and initialized; pi-durable pulls them in |
| Hermes globals | `WebSocket`, `TextEncoder`/`TextDecoder`, `AbortSignal.any`, `WeakRef`, `structuredClone`, `ReadableStream`/`WritableStream`/`TransformStream` present; `CompressionStream`, `DecompressionStream`, `Blob.prototype.stream` missing |
| Hydrating an 81 KB view over a plain link | OK |
| Sending from the app | Admitted on the server; the answer streamed back as diffs |
| Socket dropped, then `host.connect(newLink)` | Reference went `loading` with its last values, then `live`, and caught up on a message sent meanwhile |
| Chord's own `acceptWebSockets` | The 81 KB snapshot arrived as a 950-byte deflated binary frame (seen from Node); in Hermes the `get` never resolved |

**Documentation agrees.**
- The Expo SDK 58 reference for the `expo` package lists the web globals Expo installs on native, with no
  compression streams ([docs](https://docs.expo.dev/versions/v58.0.0/sdk/expo/)). Expo's
  `src/winter/runtime.native.ts` matches, in 58.0.14 and 58.0.17.
- Nothing about compression streams in:
  - the SDK 58 changelog (2026-10-15);
  - the React Native 0.88 post (2026-10-19);
  - Hermes's contrib extensions (`TextDecoder` only);
  - issues and pull requests in expo/expo, react/react-native and facebook/hermes.

## Upstream session sync

A subagent's assessment of branch `replication` at `2cf6cd898`, 2026-10-21. It is not in v1.4.0, and not on `main`.

- **Size:**
  - `src/sync/*`: 895 lines.
  - Storage-side log and replay: +634 lines.
  - Tests: +1,366 lines.
  - Together about 5% of pi-durable's source.
- **Maturity:**
  - The relevant tests pass: 101 of 101, with the full suite otherwise green.
  - The storage layer (`log`, `replay`, `head` on every built-in storage) is well covered.
  - The sync protocol has no spec.
  - `FileSystemSyncRemote` is the only remote, and is meant for development.
  - Batches hard-code gzip through `CompressionStream`, so they can't run on the phone.
  - Found gaps: no IndexedDB migration, a spurious fork after lost sync state, and a half-finished pull that can
    corrupt silently if a Harness opens before it completes.
- **Activity:**
  - One author, four commits in about ten hours.
  - Redesigned three times in about 34 hours.
  - No pull request.
  - Its changelog lines sit in the already-released 1.4.0 section.
  - It targets the maintainers' private app.
- **Judgment:** still being designed. For a one-side-at-a-time handoff, the useful upstream part will be the
  storage layer's `log(otherHead)` → `replay`, once released. Don't run the branch on real data, because of its
  unreleased schema v3.

## Measurements

| What | Value |
| --- | --- |
| Probe server bundled into one ESM file (pi-durable, pi-ai, Chord, `ws`) | 1.2 MB, 225 KB gzipped; runs on Node |
| Piece 1's server bundle (`dist/infinichat-server/server.js`, esbuild 0.28.2, pi 1.4.0) | 7.7 MB, 1.8 MB gzipped. Photon's WebAssembly as base64 ~2.5 MB; `@google/genai` ~0.9 MB, `openai` ~0.8 MB, `@anthropic-ai/sdk` ~0.65 MB, `google-auth-library` and helpers ~0.4 MB; pi-ai, pi-durable, TypeBox and Chord ~1.9 MB |
| Piece 1's server on macOS, Node 25.6.1 | `SIGTERM` with a client connected: exits 0 in 0.03 s |
| Same, as a Bun-compiled executable (darwin-arm64) | 62 MB (not used: Node is required instead) |
| Official Node 22 tarballs (darwin-arm64, linux-x64) | 26 MB, 31 MB (not used) |
| The phone's InfiniChat database, 2026-10-21 backup | 32 MB, plus a 4.1 MB WAL |
| Piece 2's asset (`assets/infinichat-server/server.bin`, esbuild 0.28.2, pi 1.4.0) | 8,109,307 bytes, 1,880,796 gzipped |

## Piece 2 on macOS

**Checks, 2026-10-21**, on the implementer's Mac: arm64, macOS, zsh, Node 24.5.0 from Homebrew. `brew shellenv` sits in
`~/.zprofile`, so Node is on the login shell's `PATH` only. The real `install.ts` ran on Node with react-native-ssh and
the Expo modules replaced by throwaway stand-ins (not committed): each script ran as sshd runs a command, through
`$SHELL -c` with sshd's environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`). The Keychain was a file. `ssh localhost`
itself was not available non-interactively.

| Check | Result |
| --- | --- |
| Node through the login shell | `/opt/homebrew/bin/node`, 24.5.0. The non-login command `ssh` runs finds no `node` |
| Node hidden from the login `PATH`; a `node` printing 20.11.0 first on it | Both stop with "InfiniChat needs Node 22.19 or newer on …" before anything is written |
| First install | Upload, secret, LaunchAgent, ready in 1.5 s. `~/.infinichat` and the bundle directory `0700`; `secret`, `server.js` and the plist `0600`; `plutil -lint` OK; a device name with `'` and `&` arrives intact |
| Install again, nothing changed | No upload, no restart (same pid), 0.25–0.35 s |
| `server` handshake from a throwaway Chord client with the secret | `{ bundle: "c8b959ca…", pi: { durable, ai, chord: "1.4.0" }, device }` |
| Wrong secret | Socket closed with 1008 |
| `setTimeZone("Asia/Tokyo")`, read through the server's inspector (`SIGUSR1`) | Same process: `new Date(0).toLocaleString("sv-SE")` from `1969-12-31 16:00:00` to `1970-01-01 09:00:00`, offset 420 → −540; `state.json` `{"timeZone":"Asia/Tokyo"}` |
| `setTimeZone("Not/AZone")` | Rejected (`unavailable: Invalid time zone specified`); `state.json` unchanged |
| `launchctl kickstart -k` by hand | Back with a new pid and port; `TZ` restored from `state.json` |
| `kill -9` | launchd starts it again (KeepAlive on failure) |
| `SIGTERM` | Exits 0 and stays stopped; the next install's `kickstart` starts it (1.4 s) |
| `kickstart -k` after changing the plist (a probe agent) | Restarts the old `ProgramArguments` |
| `bootstrap` right after `bootout` | "Bootstrap failed: 5: Input/output error"; the service stays listed ~0.1 s after `bootout` returns. Waiting until `launchctl print` fails: 5 of 5 rounds OK |
| Changed bundle (the asset plus a trailing comment) | Upload, `bootout`, `bootstrap`, ready, the old directory removed, the handshake names the new bundle: 2.4–2.5 s |
| Upload script fed a truncated bundle | Exit 1, temporary file removed, the published file unchanged |
| Install cancelled during the upload; during readiness | "SSH connection cancelled."; no temporary file. Left an empty or a complete bundle directory, removed by the next install |
| Phone without its secret (Keychain emptied) | New secret, `kickstart -k`, new pid; the old secret refused (1008), the new one accepted |
| Readiness script for a server that never starts | Marker only after 31 s; nothing removed |
| LaunchAgent environment (inspector) | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `TMPDIR=/var/folders/…/T/` |
| `processLock`'s socket | The LaunchAgent's server: under `/var/folders/…/T/`. A server started with sshd's environment, which has no `TMPDIR`: `/tmp/chord2-ef594aa4….sock` |
| Linux script without a user bus, on macOS with `uname` → `Linux` and `setsid` → `exec "$@"` stand-ins | Detached start with a notice; unchanged run keeps the pid; a new secret or bundle stops the old server and starts the new one |
| Linux script with logging `systemctl`/`loginctl` stand-ins | First install: `daemon-reload`, `enable`, `restart`. Unchanged: `enable --now`. New secret: `enable`, `restart`. Linger `no` read |
| systemd unit for the name `Lab "A" \ 100% $HOME` | `ExecStart=… "--device" "Lab \"A\" \\ 100%% $$HOME"` (text only) |

## Unverified until a piece checks it

- App Transport Security for `ws://127.0.0.1` through `forwardLocal` on a Release build (piece 3).
- Linux user services, with and without lingering, and the detached start (piece 2: checked on macOS with stand-ins
  only).
- `launchctl bootstrap gui/<uid>` from a real SSH session, and an SSH session's `TMPDIR` on macOS (piece 2: run from a
  local login session).
- A reboot bringing the LaunchAgent back at login (piece 2).
- The ChatGPT receiver answering a server's `manual_code` prompt (piece 4).
- Move timings on the real database (piece 5).

Checked in piece 1: the native web-search wrapper in `createChatModels` never reaches InfiniChat requests. It acts
only on a request whose signal the chat service's `openai-native-web-search` extension bound
(`src/pi/native-web-search/durable.ts`), and InfiniChat's Harness doesn't install that extension.
