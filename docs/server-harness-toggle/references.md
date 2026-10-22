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
| Each `ssh` command is abandoned after 60 s (`SSH_TIMEOUT_MS`), an upload after 300 s (`UPLOAD_TIMEOUT_MS`), at v1.4.0 | pi-env `src/ssh.ts:122-124` |
| Starting the daemon and its `hello` may take 60 s (`START_TIMEOUT_MS`), at v1.4.0 | pi-env `src/connection.ts:16-17` |
| `processLock` is a socket file under `os.tmpdir()` on macOS, an abstract socket on Linux, at v1.4.0 | chord `src/manager.ts:82-91`, `:133-134` |
| Node ≥ 22.19 | pi-durable `package.json` `engines` (installed 1.4.0, line 150) |
| `hold` before any upstream: the binding ends with `unavailable: no route to …`, at v1.4.0 | chord `src/host.ts:1112-1127` (`:1126`) |
| `connect` closes a still-open upstream link (`replaced`) and re-holds every binding without a hold, at v1.4.0 | chord `src/host.ts:953-967` |
| An upstream link's close detaches its bindings (`loading`, values kept) and rejects its calls in flight with `unavailable: link to … closed`, at v1.4.0 | chord `src/connection.ts:1236-1258`, `src/remote.ts:305-315` |
| A call on a `loading` reference waits for `live`, cancelled only by its `ctx` signal (`aborted`, with the signal's reason as `cause`), at v1.4.0 | chord `src/remote.ts:335-340`, `src/object.ts:544-556` |
| A reference method called without a `ctx` starts its own root; with `{ signal }` a root's calls end with it, at v1.4.0 | chord `src/remote.ts:640-646` |
| `host.close()` disposes objects and closes links, but leaves a held remote reference `loading`, at v1.4.0 | chord `src/host.ts:1231-1241` |
| Links ping every 15 s and close after 45 s without a frame, at v1.4.0 | chord `src/connection.ts:439-448` |
| `webSocketLink`'s `compress` defaults to false; the link closes its socket with 1000 when it ends, at v1.4.0 | chord `src/link.ts:356`, `:369`, `:398`, `:410` |
| `forwardLocal` closes itself when the connection drops, `onClosed` with a reason; SSH keepalive 15 s × 3 | react-native-ssh `src/index.ts:353-369`, `:400-401` |
| Expo's tsconfig loads the DOM lib, whose `WebSocket` constructor has two parameters; React Native declares three | expo `tsconfig.base.json:9`; react-native `src/types/globals.d.ts:569-578` |
| `AbortController.abort(reason)` and `signal.reason` | react-native 0.88 `src/private/webapis/dom/abort-api/AbortController.js:63`, `AbortSignal.js:158` |
| `Stack.Toolbar.MenuAction isOn` is the menu item's `on` state; a root menu's `title` is also the button's label | expo-router 58.0.25 `build/layouts/stack-utils/toolbar/StackToolbarMenu/index.js:186-193`, `:57-64` |
| A server whose object is forced away (its host closing) sends `gone` for each hold before closing the link; the binding's waiting calls reject with it, at v1.4.0 | chord `src/connection.ts:921-927`, `src/remote.ts:291-297` |
| iOS app states: a return from the background is `background` → `active`; `inactive` comes from WillResignActive | react-native 0.88 `React/CoreModules/RCTAppState.mm:115-124` |
| `CredentialStore`: `modify` is the only write path; the app persists a login's credential through it, at v1.4.0 | pi-ai `src/auth/types.ts:50-94`; installed `README.md:456-468` |
| `AuthPrompt` (`text`, `secret`, `select`, `manual_code`, each with an optional `signal`), `AuthEvent`, `AuthInteraction`, at v1.4.0 | pi-ai `src/auth/types.ts:119-161` |
| `LoginOptions.getDeviceId`: the same installation ID on every call; `agentName`, at v1.4.0 | pi-ai `src/auth/types.ts:201-214` |
| `models.login` runs the provider's flow and persists through `credentials.modify`; `logout` deletes, at v1.4.0 | pi-ai `src/models.ts:775-830`, `:832-841` |
| ChatGPT on Node: a UUID device ID is required; a busy port 1455 throws before any URL; `auth_url`, then a `manual_code` prompt that races its callback server; the server closes when the attempt ends, at v1.4.0 | pi-ai `src/auth/oauth/openai-chatgpt.ts:225-231`, `:243-248`, `:264-282`, `:288-297` |
| A pasted callback must match the attempt's redirect and state, at v1.4.0 | pi-ai `src/auth/oauth/openai-chatgpt.ts:53-78` |
| pi-ai's CLI makes a new installation ID per login; "apps should reuse one across logins", at v1.4.0 | pi-ai `src/cli.ts:51`, `:73` |
| pi-ai's CLI reads an `auth.json` it cannot parse as empty, at v1.4.0 | pi-ai `src/cli.ts:19-26` |
| `getAuth` rejects with `ModelsError` `oauth`: "token refresh failed, credential preserved for re-login" | pi-ai installed 1.4.0 `README.md:401` |
| `AuthContext`: environment and file access for auth resolution, injectable | pi-ai `src/auth/types.ts:96-101` |
| OAuth flows load through a variable `import()` bundlers cannot follow; a single-file binary registers them statically, at v1.4.0 | pi-ai `src/auth/oauth/load.ts:4-13`, `:29-31`; `src/bun-oauth.ts:13`; coding-agent `src/bun/runtime-setup.ts:10` |
| Long waits are state and their answer a separate call, not a call held open, at v1.4.0 | chord `docs/guide.md:503-518` |
| A member may not be both state and method, at v1.4.0 | chord `src/contract.ts:237` |
| `AuthRequest.promptAsync({ url })` uses only `redirectUri` (the session's return URL) and `state` (`parseReturnUrl`) | expo-auth-session 58.0.14 `src/AuthRequest.ts:137-201` |
| The native receiver accepts any non-empty state of at most 1,024 bytes without control characters | `modules/pi-oauth-callback/ios/OAuthCallbackServer.swift:54-55`, `OAuthCallbackHTTP.swift:57-58` |
| Members a contract may not use include `release`, a reference's own method, at v1.4.0 | chord `src/contract.ts:179-193` |
| Past the flow-control window (256 KiB), each member's waiting state sits in its own slot and the slots flush in creation order; only frames of one stream stay in order, at v1.4.0 | chord `docs/spec.md:242`, `:287`; `src/connection.ts:325-350` |
| Node's SQLite close checkpoints the WAL (`TRUNCATE`) and closes, so a clean close leaves no WAL, at v1.4.0 | chord `src/sqlite/node.ts:166` |
| Partials commit every 100 ms; a resumed generation turns a committed partial into an assistant entry with `stopReason: "aborted"`, after a close or a crash alike, at v1.4.0 | pi-durable `README.md:502`; `src/harness/generation.ts:429-438`, `:214`, `:307` |
| Upstream session sync hands a running generation over by opening a copy, whose recovery resets it to pending | pi branch `replication` at `2cf6cd898`, `packages/durable/test/sync-e2e.test.ts:143-171` |
| expo-sqlite opens a database by name in `defaultDatabaseDirectory` (`<Documents>/SQLite` on iOS); `databasePath` is that folder and the name | expo-sqlite 58.0.13 `src/SQLiteDatabase.ts:583`, `src/pathUtils.ts:24-36`, `ios/SQLiteModule.swift:24-30` |
| Copying only the `.db` of a live WAL database misses commits in its WAL | expo-sqlite skill `references/web-and-config.md`, "Backups and serialization" |
| `File.writableStream()` writes through `FileHandle(forWritingTo:)`, which needs an existing file; `File.digest('SHA-256')` hashes natively in 64 KiB reads | expo-file-system 58.0.10 `build/File.d.ts:154`, `ios/FileSystemFileHandle.swift:67`, `ios/FileSystemFile.swift:59-90` |
| `openShell` delivers stdout as native-owned `ArrayBuffer`s; `close()` resolves after `onClosed` | react-native-ssh 0.3.0 `src/index.ts:124-130`, `:241` |
| expo-modules-core turns a plain path into a file URL | expo-modules-core 58.0.24 `ios/Core/Arguments/Convertibles.swift:13-39`, `ios/Utilities/Utilities.swift:62-83` |

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
| Piece 4's asset, with pi-ai's OAuth flows registered statically | 8,246,243 bytes, 1,907,540 gzipped (bundle `9711b916…`); after the review 8,247,840 bytes (bundle `f296c97f…`) |
| The server's `catalog` state (six providers, 490 models) | 115,466 bytes of JSON; identical to the phone's own `buildModelCatalog` |
| Piece 5's asset | 8,256,566 bytes (bundle `96acc658…`) |
| Moving the realistic copy over loopback (piece 5) | 43,520,560 bytes there in 943 ms, adopted in 57 ms; 39,211,008 bytes back in 156 ms |

## Piece 2 on macOS

**Checks, 2026-10-21, rerun 2026-10-22 after the review**, on the implementer's Mac: arm64, macOS, zsh, Node 24.5.0 from Homebrew. `brew shellenv` sits in
`~/.zprofile`, so Node is on the login shell's `PATH` only. The real `install.ts` ran on Node with react-native-ssh and
the Expo modules replaced by throwaway stand-ins (not committed): each script ran as sshd runs a command, through
`$SHELL -c` with sshd's environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`). The Keychain was a file. `ssh localhost`
itself was not available non-interactively.

| Check | Result |
| --- | --- |
| Node through the login shell | `/opt/homebrew/bin/node`, 24.5.0. The non-login command `ssh` runs finds no `node` |
| Node hidden from the login `PATH`; a `node` printing 20.11.0 first on it | Both stop with "InfiniChat needs Node 22.19 or newer on …, on its login shell's PATH …" before anything is written |
| `uname -o` answering `Android` | Stops with "InfiniChat runs on macOS and Linux machines, and … is neither." |
| First install | Upload, secret, LaunchAgent, ready in 1.5 s. `~/.infinichat` and the bundle directory `0700`; `secret`, `server.js` and the plist `0600`; `plutil -lint` OK; a device name with `'` and `&` arrives intact |
| Install again, nothing changed | No upload, no restart (same pid), 0.25–0.35 s |
| `server` handshake from a throwaway Chord client with the secret | `{ bundle: "c8b959ca…", pi: { durable, ai, chord: "1.4.0" }, device }` |
| Wrong secret | Socket closed with 1008 |
| `setTimeZone("Asia/Tokyo")`, read through the server's inspector (`SIGUSR1`) | Same process: `new Date(0).toLocaleString("sv-SE")` from `1969-12-31 16:00:00` to `1970-01-01 09:00:00`, offset 420 → −540; `state.json` `{"timeZone":"Asia/Tokyo"}` |
| `setTimeZone("Not/AZone")` | Rejected (`unavailable: Invalid time zone specified`); `state.json` unchanged |
| `launchctl kickstart -k` by hand | Back with a new pid and port; `TZ` restored from `state.json` |
| `kill -9` | launchd starts it again (KeepAlive on failure) |
| `SIGTERM` | Exits 0 and stays stopped. The next install sees a dead pid in `server.json`, boots the stopped service out and bootstraps it (1.3 s) |
| A failed reload: the new bundle's plist on disk while launchd still runs the old one | The next install sees `server.json` naming the old bundle, reloads, and is ready on the new one (2.7 s) |
| New secret within ~10 s of the last start | `kickstart -k` waits out launchd's respawn throttle: ready in 10.4 s instead of 1.3 s |
| `kickstart -k` after changing the plist (a probe agent) | Restarts the old `ProgramArguments` |
| `bootstrap` right after `bootout` | "Bootstrap failed: 5: Input/output error"; the service stays listed ~0.1 s after `bootout` returns. Waiting until `launchctl print` fails: 5 of 5 rounds OK |
| Changed bundle (the asset plus a trailing comment) | Upload, `bootout`, `bootstrap`, ready, the old directory removed, the handshake names the new bundle: 2.4–2.5 s |
| Upload script fed a truncated bundle | Exit 1, temporary file removed, the published file unchanged |
| Install cancelled during the upload; during readiness | "SSH connection cancelled."; no temporary file. Left an empty or a complete bundle directory, removed by the next install |
| Phone without its secret (Keychain emptied) | New secret, `kickstart -k`, new pid; the old secret refused (1008), the new one accepted |
| A `node` that reports 22.19.0 and never serves | The readiness step's 60 s timeout: "InfiniChat did not start on …" after 61.6 s; the remote wait ended with the channel. The next install with the real Node recovers |
| Detached branch facing an old server that ignores `SIGTERM` | No second server; the step's timeout ends it after 60.4 s with "InfiniChat's service could not be started on …"; the remote wait ended with the channel |
| LaunchAgent environment (inspector) | `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `TMPDIR=/var/folders/…/T/`, which is `getconf DARWIN_USER_TEMP_DIR` |
| `processLock`'s socket | The LaunchAgent's server: under `/var/folders/…/T/`. A server started with sshd's environment, which has no `TMPDIR`: `/tmp/chord2-ef594aa4….sock` |
| Linux script without a user bus, on macOS with `uname` → `Linux` and `setsid` → `exec "$@"` stand-ins | Detached start with a notice; unchanged run keeps the pid; a new secret or bundle stops the old server and starts the new one |
| Linux script with logging `systemctl`/`loginctl` stand-ins | Another bundle in `server.json`: `daemon-reload`, `enable`, `restart`. This bundle running: `enable`. New secret: `daemon-reload`, `enable`, `restart`. Linger `no` read |
| systemd unit for the name `Lab "A" \ 100% $HOME` | `ExecStart=… "--device" "Lab \"A\" \\ 100%% $$HOME"` (text only) |

## Piece 3 on macOS

**Checks, 2026-10-22**, on the implementer's Mac (arm64, Node 24.5.0 from Homebrew on the login shell's `PATH`),
with pi 1.4.0 (tag `4a080252f`), React Native 0.88.0, react-native-ssh 0.3.0 and expo-router 58.0.25 installed. No
device or simulator was used.
- **What ran:** the app's real `RemoteInfiniChat`, `install.ts`, contract, `RemoteHostRepository` and Chord, bundled
  for Node with esbuild, against the real server asset (bundle `c8b959ca…`).
- **Stand-ins, not committed:**
  - react-native-ssh: each command ran as sshd runs it (`$SHELL -c`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin`), and
    `forwardLocal` piped a loopback listener to the server's port. It could drop the tunnelled sockets, or the whole
    connection with `onDisconnected` and the forward's `onClosed`, and refuse new connections.
  - The Keychain, expo-crypto, expo-asset and expo-file-system.
  - React Native's `WebSocket(url, protocols, { headers })` mapped onto Node's `WebSocket(url, { protocols,
    headers })`.
- **The phone's zone** was `TZ=Asia/Kolkata`.
- **Servers:** first a server started by hand (`TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, a temporary secret), then
  the LaunchAgent that install created.
- **Afterwards:** `~/.infinichat`, the LaunchAgent and its plist were removed, and no server process or Chord lock
  socket was left.

| Check | Result |
| --- | --- |
| Before connecting | View `loading`, no controls, no messages, scheduled `undefined` |
| Connect to a running server of this bundle | Connected in 61–63 ms. One SSH connection, no install scripts. The server's view said `loading`, then `ready` |
| Hydrate | `snapshot.view` `ready`, controls, messages (a new conversation: 0), scheduled `[]` |
| `setTimeZone` | `state.json` `{"timeZone":"Asia/Calcutta"}`, the phone's resolved zone |
| `accept` before models are chosen | "Choose InfiniChat’s models in its settings to send a message." |
| `updateSettings` with an unknown model | "The model no-such-model is unavailable from OpenAI. Choose a model in chat settings." (no code prefix) |
| `updateSettings` | Resolved; the new instructions were in `controls` 3–8 ms later |
| `accept` with models chosen and no credential | "Sign in or connect OpenAI in Account to send a message.", with the `unavailable: ` prefix stripped |
| `stop`, `dismissError`, `cancelScheduled` of an unknown task | Resolved; `false` for the unknown task |
| Socket drop (the tunnelled TCP connections destroyed) | `connecting` with the last messages and controls kept, then connected again by itself in 17–21 ms over one new SSH connection |
| SSH loss (`onDisconnected`, the forward closing with a reason) | Connected again by itself in 18–20 ms, over a new connection |
| Machine unreachable after a drop | The attempt failed with "The SSH server could not be reached through Tailscale. Check the VPN, address, and SSH port." Values were kept, and nothing retried in the next 500 ms |
| A call while that attempt failed | Rejected with the same message |
| A call while failed, machine reachable again | It started the reconnect, waited for it, went through (44–50 ms), and showed the change another client made meanwhile (catch-up) |
| `close()` | Resolved at once. The sockets reported their close 22 ms later; then no SSH connection, forward, shell or socket was left. The Node process exited on its own |
| Stale `server.json` (the hand-started server stopped by `SIGTERM`, the file naming its dead pid) | Install ran (stages connecting, checking, starting), bootstrapped the LaunchAgent, waited for the new `server.json`, connected: 1.34–1.37 s, two SSH connections. The same conversation |
| Wrong secret (the Keychain held another one than `~/.infinichat/secret`) | The socket was closed with 1008. Install wrote this phone's secret, `kickstart -k` restarted the server, and the client connected: 10.4 s, launchd's respawn throttle (piece 2). The replaced secret was refused with 1008 afterwards |
| Renamed machine (the server answered as the old `--device`) | Install rewrote the LaunchAgent with the new name, booted it out and in, and connected: 2.4 s |
| `close()` during an install, at the checking stage | Cancelled in 22–23 ms; no SSH connection or shell left |
| **After the review**, the same harness with Chord `call` frames counted off the tunnel | 38 of 38 checks |
| Machine removed from Remote machines | Failed at once, with no SSH connection: "This machine was removed from Remote machines. Choose This iPhone or another machine in the InfiniChat header." |
| `resume()` while the link is live (back from the background) | The link was replaced in 21 ms over one new SSH connection, and the old one closed. While connecting, the view stayed `ready` with the same controls and messages |
| A call made while the link was being replaced | Waited, then went through; one `updateSettings` frame on the wire |
| A call already on the wire when the link was replaced | Rejected with "The connection to test-mac was lost. Try again."; one frame, never resent. The server applied it anyway: its instructions were there after the next connect |
| Becoming active from `inactive` (`reconnect()` on a live link) | No new SSH connection |
| The server stopped by `SIGTERM` while connected | The reference went `gone` and the client reconnected by itself, keeping the last values. A call in that window rejected with "The connection to test-mac was lost. Try again.", not Chord's text. Install started the stopped LaunchAgent again, and the client connected in 1.34 s |
| `npx expo export --platform ios` | Bundled (Hermes bytecode, 13 MB) |

## Piece 4 on macOS

**Checks, 2026-10-22, rerun after the review** (45 of 45), on the implementer's Mac (arm64, Node 24.5.0 from
Homebrew), with pi 1.4.0 (tag `4a080252f`), Expo 58.0.17, expo-auth-session 58.0.14 and expo-router 58.0.25 installed.
No device or simulator was used, and nothing signed in to a real account.
- **What ran:** the app's real `RemoteInfiniChat`, contract, Chord, `RemoteHostRepository`, `openOpenAIBrowserFor`
  with expo-auth-session's `AuthRequest`, and the phone's own `createChatModels` and `createChatCredentialStore`,
  bundled for Node with esbuild, against the real server asset (bundle `9711b916…`).
- **Stand-ins, not committed:**
  - react-native-ssh, the Keychain and React Native's three-argument `WebSocket`, as in piece 3;
  - the native receiver, expo-web-browser's authentication session, expo-linking, expo-constants and React Native's
    `Platform`. The fake browser followed the authorization URL's redirect to the phone's `127.0.0.1:1455` with that
    URL's `state`, a made-up code and a made-up client ID, or closed without one.
- **The server** was started by hand with `TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, sshd's `PATH`, no real credentials
  and no provider variables but one made-up `XAI_API_KEY`. Outbound HTTPS was sent to a closed port
  (`NODE_USE_ENV_PROXY=1`, `HTTPS_PROXY=http://127.0.0.1:9`), so token exchanges and refreshes failed locally and
  nothing reached OpenAI.
- **Port 1455** was free on the Mac before the run.
- **Afterwards:** `~/.infinichat` was removed, and no server process, LaunchAgent, Chord lock socket or listener on
  1455 was left.

| Check | Result |
| --- | --- |
| Before connecting | No catalog, access or attempt |
| Hydrate | `catalog`: six providers, 490 models, 115,466 bytes, identical to the phone's own catalog. `access`: every provider `ready`, none connected. `signInAttempt`: `null`. No install ran |
| A `credentials.json` that does not parse, before the start | Read as empty: no provider error. The first key from the phone replaced its content |
| The made-up `XAI_API_KEY` in the service's environment | xAI not connected, and `accept` with an xAI model: "Sign in or connect xAI on test-mac to send a message." |
| `setApiKey` with a fake Anthropic key (spaces around it) | Access `connected`, `api_key`, 9 ms. `credentials.json` holds the store's item with the trimmed key, mode `0600` in a `0700` directory |
| Atomic write | A second key: `rename:credentials.json.<pid>` then `rename:credentials.json`, a new inode, no temporary file left, both items kept |
| `setApiKey` with spaces only | "Enter an API key." from the server |
| `signOut` | Access not connected in 2–10 ms; the item removed, the other kept |
| `signIn('openai')` | In 6–14 ms the phone had attempt 1's URL: `auth.openai.com`, the redirect `http://127.0.0.1:1455/auth/callback`, `agent_name_hint=InfiniChat`, `ext_agent_host_id=urn:uuid:…`, S256 PKCE. A `manual_code` prompt waited, with "Finish sign-in with the browser return URL." |
| Installation ID | Saved as `pi.openai.host.v1` in `credentials.json`; the same `ext_agent_host_id` on every later attempt |
| pi-ai's callback server | Listening on the machine's 1455 during the attempt, gone 150 ms after it ended |
| `cancelSignIn` | Ended in 2 ms with "Sign-in cancelled.", no prompt, nothing stored. A stale answer afterwards changed nothing |
| A second `signIn` during an attempt | The first ended; the new attempt had its own prompt; one listener on 1455 (no `EADDRINUSE`) |
| `setApiKey` while signing in | "Finish or cancel sign-in before changing provider credentials." |
| The tunnelled sockets dropped mid-attempt | The client kept the attempt and its prompt while connecting, reconnected over one new SSH connection, and showed the same prompt ID |
| A new client (an app relaunch) mid-attempt | Found the pending prompt and the URL. Closing it left the attempt running |
| The phone's ChatGPT path (receiver and browser stand-ins) | The receiver started with the server URL's 43-character state. The callback answered the machine's `manual_code` prompt, pi-ai accepted it and reported its token exchange ("Sign-in in progress…"), which failed at the closed proxy port: "Sign-in could not be completed. Please try again." in 64–74 ms. The browser was dismissed and the receiver stopped; nothing was stored |
| The browser closed without a callback | The machine's `manual_code` prompt stayed for a pasted URL |
| A pasted URL of another attempt | pi-ai refused it on the machine before any request; the attempt failed |
| `signIn('deepseek')` | "DeepSeek has no sign-in." |
| Port 1455 held by another listener on the machine | The attempt failed before any URL or prompt, with pi-ai's own status: "Port 1455 is in use, probably by an unfinished login in another pi session or by the Codex CLI. Cancel that login and try again." |
| A declined callback (`error=access_denied` with the attempt's state), the hook's branch replayed | The phone's check said "OpenAI declined the sign-in request. Start sign-in again."; `cancelSignIn` ended the machine's attempt ("Sign-in cancelled."); nothing stored; 1455 released |
| A made-up expired ChatGPT grant, `accept` with an OpenAI model | The refresh met the closed port: "Could not renew the OpenAI sign-in on test-mac. Sign in again.", the grant kept and still shown connected |
| `pi.openai.host.v1` set to `not-a-uuid` | ChatGPT sign-in ended with "The saved OpenAI installation ID could not be restored." |
| `credentials.json` mode `000` at start | Each provider: "Could not restore your saved provider credentials. Check that ~/.infinichat/credentials.json on test-mac can be read and written, then try again." With mode `0600` again, the next key from the phone was saved |
| Server restart (`SIGTERM`, started again; four starts in the run) | A new client: the API key still connected; no attempt (`null`) |
| The phone's own account | Its Keychain held only InfiniChat's secret before and after; its store listed no credentials |
| Before the fix: pi-ai's flows without `registerBunOAuthFlows()` | `models.login` rejected with `ERR_MODULE_NOT_FOUND` for `openai-chatgpt.js` next to the bundle |
| `npx expo export --platform ios` | Bundled (Hermes bytecode, 13 MB) |

## Piece 5 on macOS

**Checks, 2026-10-22**, on the implementer's Mac (arm64; the server on Node 24.5.0 from Homebrew, the phone's code on
Node 25.6.1), with pi 1.4.0 (tag `4a080252f`), Expo 58.0.17, expo-sqlite 58.0.13, expo-file-system 58.0.10 and
react-native-ssh 0.3.0 installed. No device or simulator was used. The final run passed 74 of 74 checks. The copies
ran over loopback, so the times are the Mac's, not Tailscale's.
- **What ran on the phone's side:** one Node process per launch of the app, with the app's real `ShownInfiniChat`,
  `InfiniChatMoves`, home record, `RemoteInfiniChat`, `openPhoneInfiniChat`, `openExpoSqliteStorage`,
  `createRemoteHostRepository`, contract and Chord, wired as `chat-provider.tsx` wires them, bundled with esbuild.
  A screen was a subscriber on the shown view that recorded every value it got.
- **Stand-ins, not committed:** react-native-ssh (each command run as sshd runs it, `$SHELL -c` with sshd's `PATH`;
  `forwardLocal` a loopback pipe; an optional rate limit), expo-sqlite (`node:sqlite`, logging each open and close),
  expo-sqlite/kv-store and the Keychain (files, so a relaunched process kept them), expo-file-system's `File` (over
  `node:fs`), expo-crypto, expo-asset, expo-notifications, expo-image-manipulator, expo-location, expo-task-manager and
  the Live Activity component; React Native's three-argument `WebSocket` as in piece 3.
- **The model:** pi-ai's faux provider on the phone, scripted per message and streaming slowly.
- **The server:** started by hand with `TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, sshd's `PATH`, no provider variables
  and outbound HTTPS sent to a closed port. The real asset (bundle `96acc658…`) for everything but the mid-run moves;
  for those, the same `server/main.ts` built with pi-ai's faux providers added to its models, so a resumed run can
  finish on the machine.
- **Never both open:** the phone's opens and closes of its database (from the expo-sqlite stand-in's log) against the
  machine's `active` spans (from `state.json`'s mtime, polled every 5 ms), and `lsof` sampling both database paths
  every 25 ms.
- **The realistic database:** copies of `infinichat.db` and `infinichat.db-wal` from
  `~/pi-react-native/after-2026-10-21-1.4.0/SQLite`, in a new directory; the original's SHA-256 was the same after.
  Only counts, ids, sizes and times were printed. The copies were deleted afterwards.
- **Afterwards:** `~/.infinichat`, every copy and the harness's phone directories were removed; no server, phone
  process, LaunchAgent or Chord lock socket was left.

| Check | Result |
| --- | --- |
| Synthetic round trip, the real server: a new conversation made by the app's own code, two answers from the faux model | Move there 147 ms, back 24 ms (167,936 bytes). Transcript, message ids and controls identical on the machine and back on the phone. After the move there, `infinichat-moved.db` and no `infinichat.db` on the phone, the machine `active` with the files it adopted. After the move back the machine inactive, `data/` in `released/<time>/`, the moved copy gone |
| The screen through each move (a subscriber on the shown view) | Never `loading`, never fewer messages; the last values until the one switch to the new side |
| Mid-run move there, the faux server | The answer was streaming on the phone (20 characters in; 24 on the way back). The model was asked once on each side. The machine finished it: one user row, the interrupted attempt as a stopped answer, one complete answer |
| Mid-run move back | The same, finished on the phone |
| A send while a move holds the screens | "InfiniChat is moving. Send again once the move is done." Sent twice afterwards with its `requestId`: one user row, one model request, one answer |
| Realistic copy, `moving-there` at launch (the record only, as a phone killed after closing) | Resumed from step 3 with the database and its WAL as they were: 43,520,560 bytes (39,211,008 + 4,309,552) copied in 943 ms, adopted in 57 ms; the machine’s view `ready` with 1,433 messages 1.30 s after launch |
| Realistic move back | 39,211,008 bytes (the machine's close checkpointed the WAL into the database) in 156 ms; placed and opened on the phone in 110 ms |
| Realistic moves with the phone holding it open | There 1.11 s, back 0.25 s; the same 1,433 message ids on each side |
| Counts, before, after the round trip, and in the machine's released copy | 1,682 entries, 1,840 `optchat.message` and 3,680 `optchat.node` documents, schema 2, integrity check clean, each time |
| Migration errors | None on either side: the phone and the machine opened the schema-2 database, and the server's log holds Node's experimental-SQLite warning only |
| The phone killed mid-upload (8 MB/s link, at 13.1 of 39.2 MB) | Record `moving-there`, machine inactive. The relaunch resumed at step 3 and finished there (copy 4.97 s at that rate) |
| The phone killed mid-download (at 13.1 of 39.2 MB) | Record `moving-back`, machine released and inactive. The relaunch downloaded again and finished on the phone |
| Cancel during the copy there, and back (12 and 10 repeats) | There: home `phone`, the phone open again, the machine never active. Back: the machine adopted its files again, home `there`. The screens kept their values throughout |
| The machine killed with `SIGKILL` while holding the conversation | Restarted by hand: it reopened the database at once (`active`), and a relaunched phone showed the same 1,433 messages |
| The machine restarted while released (the phone killed mid-download) | It opened nothing (`lsof`); the relaunched phone finished the move back |
| Unreachable machine (new connections refused, live sessions dropped) | A move there stopped at "Connecting to test-mac failed. …" with the phone still open and the record `phone`; a move back stopped at "Closing InfiniChat on test-mac failed. …" with the record `there`. Cancel cleared each. A launch with the conversation there showed the machine at once with its failed connection; Try Again showed the conversation |
| Never both open, in every section | No overlap between the phone's opens and the machine's `active` spans, and `lsof` never saw both databases open (about 930 samples) |
| Found by these checks and fixed | The first `ready` overtaking 1,433 messages (`snapshot` now last); a Cancel's queued `closeMachine` handing the next move a closing client whose `connected()` never settled |
| The stand-in itself | Its channel close first left `cat` waiting on an open stdin, which a real channel close ends; fixed in the stand-in before the repeats |

## Unverified until a piece checks it

- App Transport Security for `ws://127.0.0.1` through `forwardLocal` on a Release build (piece 3).
- Piece 3 in Hermes and on the phone: the header menu and its checkmark, `Intl` time zone names, React Native's
  WebSocket with the `Authorization` header through a real `forwardLocal`, reconnects after a locked or suspended app
  and after Tailscale goes off and on, a killed app, and a send admitted once after a reconnect (the server has no
  credentials until piece 4).
- Piece 3 against Linux: the systemd and detached branches of install-when-needed.
- Piece 3: a call waiting on a `loading` reference when the server refuses its re-hold with `gone`. The server stops
  accepting before its host closes, so this could not be produced on the Mac; a call made after `gone` was checked.
- Linux user services, with and without lingering, and the detached start (piece 2: checked on macOS with stand-ins
  only).
- `launchctl bootstrap gui/<uid>` from a real SSH session, and an SSH session's `TMPDIR` on macOS (piece 2: run from a
  local login session).
- A reboot bringing the LaunchAgent back at login (piece 2).
- Piece 4 on the phone: the real receiver and authentication session with a server's URL and state, a real ChatGPT
  grant stored on the machine and then used and refreshed there, the providers screen and its notices, and pasting
  into the machine's prompt. On the Mac the receiver and browser were stand-ins and no token exchange reached OpenAI.
- Piece 4 on Linux, and pi-ai's other sign-in flows on a machine (Anthropic, OpenRouter, xAI), which the phone does
  not offer.
- Piece 5 on the phone: the move with Tailscale's real latency and bandwidth (the Mac's copies ran over loopback),
  `defaultDatabaseDirectory` and `File` with the app's real container paths, expo-file-system's `writableStream` and
  `digest` on a 40 MB file, expo-sqlite's close leaving no WAL, the header's progress and the menu's Cancel Move, the
  screens keeping their scroll and draft through a move, and a killed app relaunching into a move.
- Piece 5 against Linux, and against a machine whose `released/` holds earlier conversations.

Checked in piece 1: the native web-search wrapper in `createChatModels` never reaches InfiniChat requests. It acts
only on a request whose signal the chat service's `openai-native-web-search` extension bound
(`src/pi/native-web-search/durable.ts`), and InfiniChat's Harness doesn't install that extension.
