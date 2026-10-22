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
  at v1.4.0, `:396` onward and `:464-472`). The login shell is there because "`ssh` runs commands without a login
  shell", and Node installed through Homebrew, nvm or fnm is often only on the login shell's `PATH`.
- react-native-ssh 0.3.0: `connect`, `exec` and `openShell`, as `channel.ts` and `command-channel.ts` use them.

## Builds

### The bundle as an app asset

- `scripts/build-infinichat-server.mjs` (from piece 1) also writes `assets/infinichat-server/server.bin` and
  `src/pi/infinichat-remote/server-manifest.ts`:
  - `{ sha256, size }`;
  - the pi package versions the bundle was built with.

  Like the daemon script, it gets a `--check` mode, so a stale asset fails the build checks.
- `server-assets.ts` loads and verifies the asset exactly as `daemon-assets.ts` loads the daemon. The bundle is one
  file of about 7.7 MB (1.8 MB gzipped), measured with piece 1. Most of it is:
  - Photon's WebAssembly, embedded as base64: ~2.5 MB;
  - the provider SDKs `createChatModels` pulls in: `@google/genai` ~0.9 MB, `openai` ~0.8 MB,
    `@anthropic-ai/sdk` ~0.65 MB, and `google-auth-library` with its helpers ~0.4 MB;
  - pi-ai, pi-durable, TypeBox and Chord, together ~1.9 MB.

  The probe's server, with a faux model and no Photon, was 1.2 MB.

### Provisioning: `src/pi/infinichat-remote/install.ts`

Over one short-lived SSH connection opened with the machine's admission. Credentials and the pinned host key come
from `hosts.admit(machineId)`, as `owner.ts` builds `admittedSshChannel`. Steps, each reporting progress to the UI:

1. **Node.** Find it with `$SHELL -lc 'command -v node; node -p process.versions.node'` and require ≥ 22.19.
   Otherwise stop with: "InfiniChat needs Node 22.19 or newer on <machine>. Install it there and try again." Record
   the absolute path of the `node` that was found.
2. **Bundle.** Upload to `~/.infinichat/server/<sha256[0:32]>/server.js` when it isn't already there, with
   provisioning.ts's check, upload, verify and rename script. Server directories of other hashes are removed only
   after the new service has started.
3. **Secret.** The phone generates 32 random bytes with `expo-crypto` and keeps them in the Keychain per machine,
   through the existing `CredentialBackend` (`src/pi/secure-storage.ts`). It writes them to `~/.infinichat/secret`
   with `umask 077`. If the phone has no secret for a machine whose file exists (a reinstalled phone), it writes a
   new one and restarts the service.
4. **Service.** Started by the machine's own service manager, so the server outlives the SSH session:
   - **macOS:** a LaunchAgent, `~/Library/LaunchAgents/com.vikashloomba.piagent.infinichat.plist`, with
     `ProgramArguments` of the recorded `node`, `server.js`, `serve` and `--device <name>`. It sets `RunAtLoad`, and
     `KeepAlive` with `SuccessfulExit: false`, so a clean stop stays stopped and a failure restarts. Load it with
     `launchctl bootstrap gui/$(id -u) …`, or `launchctl kickstart -k` after an update.
   - **Linux:** a systemd user unit, `~/.config/systemd/user/infinichat.service`, with `Restart=on-failure`, then
     `systemctl --user daemon-reload` and `enable --now`. Without lingering (`loginctl enable-linger`, which needs an
     administrator) a user service stops at the last logout. The setup result says so instead of failing.
   - **No user service manager** (no user bus, a container): start it detached with `nohup` and `setsid`. The phone
     starts it again whenever it connects and finds it not running.
5. **Ready.** Read `~/.infinichat/server.json` until it names a live `pid`, the `port` and this bundle's hash.

### Version handshake

The contract gains a `server` state member: `{ bundle, pi: { durable, ai, chord, env }, device }`. The phone
compares `bundle` with its manifest:

- On a mismatch it reinstalls (steps 2 and 4) before it shows anything.
- It never moves a conversation to a server of another bundle (piece 5), because pi-durable's SQLite migrations are
  one-way.

**Time zone.** On every connect the phone also calls `setTimeZone(zone)` with its IANA zone
(`Intl.DateTimeFormat().resolvedOptions().timeZone`). The server keeps it in `~/.infinichat/state.json`, sets
`process.env.TZ` from it at start and on each change (Node applies `TZ` changes at run time), so the times the agent
reads match the phone's clock wherever the machine is.

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| Install SSH connection | `install.ts`, per run | the UI's AbortSignal | `install.ts`, when the run ends |
| Server process | the machine's service manager | — | the service manager (`launchctl bootout`, `systemctl --user stop`) |
| Secret | the phone, at first install | — | replaced on reinstall; never sent anywhere else |

The phone's SSH session never owns the server. A dropped install leaves at most a temporary file, which the next
run's upload script removes, as provisioning.ts does.

## Deviations (need approval)

- **Service files on the user's machines:** a LaunchAgent or a systemd user unit. This is the idiomatic way to keep
  a per-user daemon running on each OS. Nothing is installed system-wide, and nothing needs `sudo`.
- **Finding Node through the login shell**, as pi-env's `loginShell` option does.

## Size

About 300 lines: the build script and manifest ~80 (after `sync-pi-daemon-assets.mjs`), `install.ts` ~150 (after
`provisioning.ts`, 95 lines, plus Node detection and services), service templates ~40, handshake ~30.

## Checks

Back up the phone's InfiniChat database first, then check on the owner's iPhone Release install:

- Install on a Mac (arm64) and on a Linux x64 machine. The progress copy shows each stage.
- A machine without Node, or with Node 20, shows the Node message.
- Reboot each machine: the server is back. On Linux without lingering, the stated behaviour.
- Ship a build with a changed bundle: the next connect reinstalls, restarts, and removes the old directory.
- A second phone install, or a reinstalled app: a new secret, and the old one is refused.

## Not in this piece

The phone UI that triggers it (piece 3 calls `install` from the header's machine menu), moves (piece 5), and uninstalling from a
machine. Uninstalling has no requirement yet; add it if the owner asks.
