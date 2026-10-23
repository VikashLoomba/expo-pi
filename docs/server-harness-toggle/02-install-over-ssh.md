# Piece 2: Install and run over SSH

## Goal

The phone installs the server on any configured machine over the SSH connection it already trusts, starts it as a
user service that survives logouts of the SSH session and reboots, and replaces it when the app ships a different
bundle. The machine must already have Node ≥ 22.19 (owner decision); nothing is downloaded.

## Starts from

- The app's pi-env daemon provisioning, the pattern to follow:
  - `src/pi/execution/remote/provisioning.ts`: detect the platform and home, name files by SHA-256, upload to a
    temporary file, verify, rename atomically, and clean up only your own temporary file.
  - `daemon-assets.ts`: a Metro `.bin` asset, read and verified against a pinned hash.
  - `scripts/sync-pi-daemon-assets.mjs`: a generated manifest with a `--check` mode.
- Upstream's version of the same steps: pi-env `deployDaemon` and its `loginShell` option (`packages/env/src/ssh.ts`
  at v1.4.0: `checkDaemon` `:389-398`, `deployDaemon` `:400-461`, `loginShell` `:466-470`, `launchCommand`
  `:475-484`). The login shell is there because "`ssh` runs commands without a login shell", and Node installed
  through Homebrew, nvm or fnm is often only on the login shell's `PATH`.
- react-native-ssh 0.3.0: `connect` and `openShell`, as `channel.ts` and `command-channel.ts` use them. `exec` has no
  stdin, so every script goes through `runSshCommand` (`openShell` with input).

## Builds

### The bundle as an app asset

- `scripts/build-infinichat-server.mjs` (from piece 1) now writes `assets/infinichat-server/server.bin` and
  `src/pi/infinichat-remote/server-manifest.ts`, instead of `dist/infinichat-server/server.js`:
  - `{ sha256, size }`;
  - the pi package versions the bundle was built with, `pi: { durable, ai, chord }`. The same versions reach the
    server through esbuild's `define` as `INFINICHAT_PI` (declared in `server/build.d.ts`). pi-ai's `exports` has no
    `./package.json`, so the script reads each version from the app's own `node_modules`.

  Like the daemon script, it gets a `--check` mode, so a stale asset fails the build checks. `--check` builds the
  bundle in memory and compares it byte for byte with the asset, and the manifest text with the file. esbuild's
  `absWorkingDir` is the repo root: the bundle's path comments are relative to the working directory, and a build
  started from another directory gave different bytes.
- `server-assets.ts` loads and verifies the asset exactly as `daemon-assets.ts` loads the daemon. `install.ts` checks
  the machine against the manifest's hash and loads the asset only when it uploads. The bundle is one file of
  8,109,307 bytes (1.9 MB gzipped). Most of it is:
  - Photon's WebAssembly, embedded as base64: ~2.5 MB;
  - the provider SDKs `createChatModels` pulls in: `@google/genai` ~0.9 MB, `openai` ~0.8 MB,
    `@anthropic-ai/sdk` ~0.65 MB, and `google-auth-library` with its helpers ~0.4 MB;
  - pi-ai, pi-durable, TypeBox and Chord, together ~1.9 MB.

  The probe's server, with a faux model and no Photon, was 1.2 MB.

### Provisioning: `src/pi/infinichat-remote/install.ts`

`installServer(hosts, machineId, { signal, onProgress })` resolves to `{ port, secret, notice? }`: the loopback port
for the tunnel, the secret the WebSocket carries, and a notice when the machine won't keep the server running by
itself. The progress stages are `connecting`, `checking` (Node and the bundle), `uploading` (only when the bundle is
missing) and `starting` (secret, service, readiness).

It runs over one short-lived SSH connection opened with the machine's admission. Credentials and the pinned host key
come from `hosts.admit(machineId)`, as `owner.ts` builds `admittedSshChannel`. Every step is a POSIX script sent
through `runSshCommand`. Its answer is what it prints after a marker, so output from the account's shell startup files
is skipped. Each step has its own fixed message, and remote output never reaches one:
- the Node and bundle checks: "Checking <machine> for InfiniChat failed.";
- the upload and the secret: the home-folder permissions and disk-space text;
- the service: "InfiniChat's service could not be started on <machine>.";
- readiness: "InfiniChat did not start on <machine>.", also when its timeout ends it.

Each step runs under `runSshCommand`'s 60-second timeout, pi-env's `SSH_TIMEOUT_MS` for each `ssh` command
(`src/ssh.ts:123`), whose daemon-start analogue is `START_TIMEOUT_MS` (`src/connection.ts:16-17`). The upload has 300
seconds, pi-env's `UPLOAD_TIMEOUT_MS` (`src/ssh.ts:124`), as provisioning.ts does. The waits inside a step have no
bound of their own; the step's timeout ends them. sshd doesn't stop a command whose session closed, so each wait prints
a line each second: once the phone's channel is gone, the next line ends the script with `SIGPIPE`.

The steps:

1. **Node.** Find it with `"$SHELL" -lc 'printf "%s\n" "$0"; command -v node && node -p process.versions.node'
   "$M-NODE"` and require ≥ 22.19. `$0` is a marker printed after the login profile's own output; upstream's
   `launchCommand` passes arguments the same way. Node must be on the login shell's `PATH`, set in `~/.zprofile` or
   `~/.profile`; nvm set up only in `~/.zshrc` isn't seen, because a login shell that runs a command isn't
   interactive. Otherwise stop with: "InfiniChat needs Node 22.19 or newer on <machine>, on its login shell's PATH
   (set in ~/.zprofile or ~/.profile, not only ~/.zshrc). Install it there and try again." Record the absolute path
   of the `node` that was found. The same script reads `$HOME` and the system, telling Android (Termux) apart with
   `uname -o` as provisioning.ts does; only Darwin and Linux are accepted.
2. **Bundle.** Upload to `~/.infinichat/server/<sha256[0:32]>/server.js` when it isn't already there, with
   provisioning.ts's check, upload, verify and rename script (`HASH` and `script` are now exported from it). The
   readiness script removes server directories of other hashes, only after the new service has started.
3. **Secret.** The phone generates 32 random bytes with `expo-crypto` and keeps them in the Keychain per machine,
   through the existing `CredentialBackend` (`src/pi/secure-storage.ts`), under `pi.infinichat.secret.v1.<machine
   id>`. It writes them to `~/.infinichat/secret` with `umask 077`. If the phone has no secret for a machine whose
   file exists (a reinstalled phone), it writes a new one and restarts the service. The secret goes over stdin, never
   on a command line. The script compares it with the file and reports `changed` only when it differs, and that
   restarts the service.
4. **Service.** Started by the machine's own service manager, so the server outlives the SSH session. The service
   counts as changed when its file differs, and also when `server.json` doesn't name this bundle and a live process:
   a reload that failed or was cancelled after an earlier run published the file left the manager on the old
   definition, and comparing the file alone would never reload it.
   - **macOS:** a LaunchAgent, `~/Library/LaunchAgents/com.vikashloomba.piagent.infinichat.plist`, with
     `ProgramArguments` of the recorded `node`, `server.js`, `serve` and `--device <name>`. It sets `RunAtLoad`, and
     `KeepAlive` with `SuccessfulExit: false`, so a clean stop stays stopped and a failure restarts. Load it with
     `launchctl bootstrap gui/$(id -u) …`. Then:
     - **Changed** (a new bundle, a renamed machine, another `node`, or a server that isn't this bundle's or has
       stopped): `launchctl bootout`, wait until `launchctl print` no longer lists the service, then `bootstrap`.
       `kickstart -k` restarts the definition launchd loaded before and ignores the new file, and a `bootstrap`
       right after `bootout` fails with "Bootstrap failed: 5: Input/output error" (both measured,
       [references](references.md#piece-2-on-macos)).
     - **Only the secret changed:** `launchctl kickstart -k`.
     - **Nothing changed** and this bundle's server is running: nothing to do.
     - **Nobody is logged in** (no `gui/<uid>` domain): setup stops with "InfiniChat starts at login on <machine>,
       and no one is logged in there. Log in, then try again." The deviations say why macOS has no detached fallback.
   - **Linux:** a systemd user unit, `~/.config/systemd/user/infinichat.service`, with `Restart=on-failure`, then
     `systemctl --user daemon-reload`, `enable` and `restart` when it changed or the secret did, and only `enable`
     otherwise. `ExecStart` quotes each argument and escapes `\`, `"`, `%` and `$`. Without lingering (`loginctl
     enable-linger`, which needs an administrator) a user service stops whenever no session is open, and the user
     manager starts it again with the next session, such as the phone's SSH connection. The setup result says so in
     its `notice` instead of failing, from `loginctl show-user <user> --property=Linger --value`.
   - **No user service manager** (Linux without a user bus, a container): start it detached with `nohup` and
     `setsid`. The phone starts it again whenever it connects and finds it not running. A running server of another
     bundle, or one that must read a new secret, gets `SIGTERM`, and the new one starts only once the old one is
     gone; if it never goes, the step's timeout ends the script before a second server starts. The result carries a
     notice.
5. **Ready.** Read `~/.infinichat/server.json` once a second until it names a live `pid`, the `port` and this bundle's
   hash; the step's timeout ends the wait. Every (re)start removes `server.json` first, so a stale file never answers.
   The script matches the exact `JSON.stringify` form `server/listen.ts` writes.

### Version handshake

The contract gains a `server` state member: `{ bundle, pi: { durable, ai, chord }, device }`. `bundle` is the name of
the server's directory, the first 32 hex digits of its SHA-256. There is no `env`: the bundle contains no pi-env until
piece 7 adds it. The phone compares `bundle` with its manifest:

- On a mismatch it reinstalls (steps 2 and 4) before it shows anything.
- It never moves a conversation to a server of another bundle (piece 5), because pi-durable's SQLite migrations are
  one-way.

**Time zone.** On every connect the phone also calls `setTimeZone({ zone })` with its IANA zone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`). The server keeps it in `~/.infinichat/state.json`, sets
`process.env.TZ` from it at start and on each change (Node applies `TZ` changes at run time), so the times the agent
reads match the phone's clock wherever the machine is. In `server/time-zone.ts`, a name that isn't an IANA zone is
refused before anything changes, and `state.json` is written aside and renamed, synchronously, so two calls never
interleave. In this piece `state.json` holds only `{ timeZone }` and each write replaces it. Piece 5 adds its own
fields, and its writes and this one must then read, modify and write the file.

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed or removed by |
| --- | --- | --- | --- |
| Install SSH connection | `install.ts`, per run | the UI's AbortSignal | `install.ts`, when the run ends |
| Server process | the machine's service manager | — | the service manager (`launchctl bootout`, `systemctl --user stop`) |
| Secret | the phone, at first install | — | replaced on reinstall; never sent anywhere else |
| Keychain item `pi.infinichat.secret.v1.<id>` | `install.ts`, when the phone has none | — | never: removing a machine leaves it (no uninstall yet) |
| `~/.infinichat/secret` | `install.ts`, replaced when it differs | — | never |
| Bundle directory `~/.infinichat/server/<hash>/` | `install.ts`'s upload | a dropped upload removes its own temporary file | a later install's readiness step, once another bundle's server is ready; never the server |
| LaunchAgent plist, systemd unit | `install.ts`, replaced when it differs | — | never (no uninstall yet) |
| `~/.infinichat/server.json` | the server, once listening (`server/listen.ts`) | — | `install.ts`, before each (re)start; never the server |
| `~/.infinichat/state.json` | the server, at `setTimeZone` | — | never |

The phone's SSH session never owns the server. A dropped install removes its own temporary file, and leaves at most a
bundle directory, which the next run's readiness step removes once its server is ready.

## Deviations (need approval)

- **Service files on the user's machines:** a LaunchAgent or a systemd user unit. This is the idiomatic way to keep
  a per-user daemon running on each OS. Nothing is installed system-wide, and nothing needs `sudo`.
- **Finding Node through the login shell**, as pi-env's `loginShell` option does.

Found while implementing, against the installed sources and this Mac:

- **`bootout` and `bootstrap` for a changed plist**, not `kickstart -k` (step 4). `kickstart -k` keeps the loaded
  definition, so after an update it would start the old bundle again.
- **No detached fallback on macOS.** This is a product-scope choice, not a technical necessity: launchd is always
  there, the `gui/<uid>` domain is missing only while nobody is logged in, and a Mac with nobody logged in gets "log
  in" instead of a server that won't survive a reboot. It also avoids two servers on one database. Chord's
  `processLock` uses a socket file under `os.tmpdir()` on macOS (`src/manager.ts:82-91`, `:133-134` at v1.4.0).
  launchd gives its agents the per-user `TMPDIR`, `$(getconf DARWIN_USER_TEMP_DIR)` (measured:
  `/var/folders/…/T/`). A server started with sshd's environment, which sets no `TMPDIR`, locked
  `/tmp/chord2-….sock` instead (measured with the stand-in; a real SSH session's `TMPDIR` is unverified), so it would
  not exclude the LaunchAgent's. A server started by hand on macOS must therefore run with
  `TMPDIR=$(getconf DARWIN_USER_TEMP_DIR)`, or be started through `launchctl`. On Linux the lock is an abstract
  socket, independent of `TMPDIR`, so the fallback stays there.
- **`pi` without `env`** in the handshake (above).
- **No `dist/` output** from the build script: the asset is the bundle.
- **No log file.** The LaunchAgent's output goes nowhere and the detached server's to `/dev/null`; systemd keeps its
  own journal. Nothing requires a log yet, and no message points at one.

## Login shell (decided 2026-10-22)

The service manager's environment lacks the login shell's `PATH` (the LaunchAgent's is `/usr/bin:/bin:/usr/sbin:/sbin`;
vikash-system's systemd unit had no nvm), so the agent's bash tool didn't find Homebrew's, nvm's or fnm's programs.
The owner chose pi-env's `loginShell: true` everywhere a machine starts something for InfiniChat or the chats: the
service runs `<login shell> -lc 'exec "$0" "$@"' <node> server.js …` (the shell is the `$SHELL` the install found over
SSH), the server's `connectSsh` to other machines passes `loginShell: true`, and the phone's own daemon channel starts
its daemon as pi-env's `launchCommand` does with that option.

## Size

Estimated at about 300 lines: the build script and manifest ~80 (after `sync-pi-daemon-assets.mjs`), `install.ts`
~150 (after `provisioning.ts`, 95 lines, plus Node detection and services), service templates ~40, handshake ~30.

As built, about 440 lines: `install.ts` 324, of which the plist, the unit and their service scripts are about 110;
`server-assets.ts` 25; the build script +35 net; the handshake and the time zone about 70 across the contract,
`server/` and `server/time-zone.ts`. The manifest and the asset are generated.

## Checks

Done in this piece on the implementer's Mac (arm64, Node 24.5 from Homebrew, on the login shell's `PATH` only): the
real `install.ts` ran on Node with react-native-ssh and the Expo modules replaced by throwaway stand-ins, each script
run as sshd runs it (`$SHELL -c`, sshd's minimal environment). The results are in
[references](references.md#piece-2-on-macos). Linux is unverified: the systemd unit was checked as text, and the
systemd and detached branches ran on macOS only, with stand-ins for `systemctl`, `loginctl`, `uname` and `setsid`.

Back up the phone's InfiniChat database first, then check on the owner's iPhone Release install:

- Install on a Mac (arm64) and on a Linux x64 machine. The progress copy shows each stage.
- A machine without Node, or with Node 20, shows the Node message.
- Reboot each machine: the server is back. On Linux without lingering, the stated behaviour.
- Ship a build with a changed bundle: the next connect reinstalls, restarts, and removes the old directory.
- A second phone install, or a reinstalled app: a new secret, and the old one is refused.

## Not in this piece

The phone UI that triggers it (piece 3 calls `installServer` from the header's machine menu), moves (piece 5), and
uninstalling from a machine. Uninstalling has no requirement yet; add it if the owner asks. Until then, removing a
machine from Remote machines leaves its InfiniChat secret in the phone's Keychain.
