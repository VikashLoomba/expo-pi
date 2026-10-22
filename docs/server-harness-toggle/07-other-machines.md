# Piece 7: Other machines

## Goal

While InfiniChat runs on machine A, its tools can use the other configured machines too, reached by A with A's own
SSH. Today's multi-machine tools keep working after a move.

## Starts from

- pi-env 1.4.0, the upstream API for this (`packages/env/README.md`):
  - `connectSsh` and `sshConnection` (`src/ssh.ts:519-532`): detect, deploy, verify and start the daemon over the
    machine's `ssh`, which runs "with `BatchMode`, strict host-key checking against the application's own
    known-hosts file under a fixed alias".
  - `scanHostKey` and `acceptHostKey` for the one-time key acceptance.
  - `RemoteExecutionEnv` for the calls.
- `SshConnectOptions.binary` and the packaged daemon layout (`src/ssh.ts:355-359`, `:464-472`). The server is a
  single bundle, so it doesn't have pi-env's `bin/` directory. The phone already ships all four daemons
  (`assets/pi-env`, `daemon-manifest.ts`).
- The phone's device list and work directories (`src/pi/infinichat/devices.ts`).

As built against pi-env 1.4.0 (tag `4a080252f`), now a dev dependency of the app that only the server bundle imports.
It is the same npm tarball (`sha512-WOO3…`) the phone's daemon assets come from. Its canonical example is the
README's (`README.md:12-29`), and its own SSH tests (`test/ssh.test.ts`, `test/ssh-external.test.ts`) show the
scan, accept and connect flow this piece follows.

## Builds

- **Which machines.** The phone tells the server the other configured machines: `{ id, name, hostname, port,
  username, hostKey }` from its records, with the pinned key's algorithm and fingerprint. It never sends credentials.
  This happens with `setMachines` on every connect and whenever Remote machines change. The server keeps the list in
  `~/.infinichat/machines.json`, so its tools work while the phone is away.
- **Devices on the server.** This machine (piece 1), plus each listed machine as a `RemoteExecutionEnv`:
  - One pi-env connection per machine, from `connectSsh` (as built, below; the plan said `sshConnection`), with
    `knownHostsFile: ~/.infinichat/known_hosts` and `hostKeyAlias: <machine id>`.
  - The work directory is `~/.infinichat/work/<who>`, as on the phone.
  - Device names and descriptions match the phone's, so the model sees the same list after a move, minus "phone".
- **Host keys.**
  - **Matching key:** before first use, the server runs `scanHostKey`. If a scanned fingerprint equals the key the
    owner already pinned on the phone for that machine, it accepts it with `acceptHostKey`, so there's nothing to
    ask.
  - **Different key:** the machine shows in a `pendingHostKeys` state member. The phone shows the fingerprint, as
    Remote machines does at setup. Accepting calls `acceptHostKey`; until then, calls to that device fail with a
    message saying so.
- **Daemon binaries.** The phone uploads the daemons it ships next to the bundle (piece 2's install). The server
  passes the one matching each detected platform as `binary`. Read pi-env's `connectSsh` at the installed version
  first: if `binary` can't be chosen after detection, lay the files out where `packagedDaemon` looks, relative to
  the bundle.
- **Access.** A reaches B only if A's own keys or agent are authorized on B. When they aren't, pi-env's error becomes
  the call's result, as an unreachable machine's does today. Remote machines on the phone shows, per machine,
  whether the current InfiniChat machine can reach it.

### As built

**The machines** (`server/machines.ts`, `ServerMachines`):
- The contract gains `setMachines({ machines })` and the `MachineSchema` it takes
  (`src/pi/infinichat-remote/contract.ts`).
  `hostKey` is `{ algorithm, fingerprint }`, left out when the phone pinned none.
- `RemoteInfiniChat` sends the list (`sendMachines` in `client.ts`):
  - once a connection is live, and whenever `RemoteHostRepository` publishes;
  - with every machine but the one InfiniChat runs on;
  - with each machine's pinned key, read through `hosts.admit`, so nothing but the key's algorithm and fingerprint
    leaves the phone.
  - A machine whose pin can't be read (an unreadable Keychain item) goes without it, so its key waits for the phone,
    the unpinned path. A machine removed between the snapshot and `admit` is left out. The rest always go.

  Sends wait for each other, so a slower build of an older list never lands last. A send that fails changes nothing,
  and the next connect sends the list again.
- The server writes `machines.json` aside, mode `0600`, and renames it into place. A file that doesn't parse reads as
  no machines, which the phone's next list replaces, as `credentials.json` does.

**The devices** (`server/devices.ts`): this machine first, then each listed machine:
- named and described as `createDevices` names and describes it (`machineDescription`);
- a `RemoteExecutionEnv` per call with `id: pi-env:<machine id>` (the README's `pi-env:<env name>` form) and
  `cwd: <home>/.infinichat/work/<who>`. `home` is what the daemon's `hello` reported (`connection.info()`), as
  `owner.ts` builds the phone's machine work dirs. The device tools then create that directory, as on the phone.

**Connections: `connectSsh`, not `sshConnection`.**
- The host-key flow has to know when the host key is why a start failed:
  - `connectSsh` rejects with `HostKeyUnknownError` or `HostKeyChangedError`, which `detectPlatform` rethrows
    (`src/ssh.ts:329-336`, `:532-540`).
  - `sshConnection`'s lazy start turns every failure into a `RemoteError` `spawn_error` carrying only the message
    (`src/connection.ts:268-276`), and the piece 4 review ruled out matching messages.
- So each machine's connection is `connectSsh`'s, opened on first use. Its later restarts are the same lazy restarts
  `sshConnection` makes (`sshConnectionFor`).
- A connection whose start fails holds nothing. It is closed and forgotten, so the next use opens it again with
  `connectSsh`, as pi-env's own `Connection` forgets a failed start (`src/connection.ts:232`).
- A connection that had answered once and then fails to restart gets one fresh `connectSsh` within the same use. Its
  lazy restart reports a changed key as pi-env's own advice, "The host key of … changed; remove the old key to
  continue" (`src/ssh.ts:163`, wrapped as a `spawn_error` at `src/connection.ts:273-275`), which a model with a
  shell on A could follow. `connectSsh` names it, so the first call after a key change already pends the key for the
  phone (measured). An offline machine whose connection had worked waits for both attempts in that call.
- A machine the phone removes or moves (another hostname, port or account) has its connection closed at once. A
  rename or a new pinned key keeps it.

**Host keys** (`open` in `machines.ts`):
- **Unknown or changed key:** `scanHostKey`, then each scanned line paired with its `ssh-keygen -l` fingerprint. pi-env
  reads both from the same file, one line per key in order. If the two lists differ in length, the scan fails rather
  than guessing.
- **A scanned fingerprint equals the phone's pin:** `acceptHostKey` with that line. When the key replaced a trusted one
  (`HostKeyChangedError`), `forgetHostKey` runs first, as pi-env requires (`src/ssh.ts:258-286`). Then `connectSsh`
  again.
- **Otherwise:** the scan waits in `pendingHostKeys`, `{ [machine id]: { keys: [{ algorithm, fingerprint }], changed }
  }`. The use fails with:
  - "studio doesn’t trust the SSH host key lab-e presents yet. Compare its fingerprint in Remote machines on the
    phone, then accept it there."
  - or, for a changed key, "The SSH host key lab-b presents to studio changed. Compare its fingerprint in Remote
    machines on the phone, and accept it there only if you know why it changed."

  Each later use scans again and stays blocked until the phone accepts.
- **`acceptHostKey({ id, fingerprints })`** accepts the waiting lines only when `fingerprints` are the ones it shows,
  so the owner accepts what they compared. Otherwise: "The SSH host key lab-e presents to studio changed again.
  Compare it again." It forgets the old keys first when the key changed, accepts, and tries the machine.
- Only fingerprints are compared. A fingerprint hashes the key blob, key type included. The phone also sends the
  algorithm, as decided; the server reads only the fingerprint.

**Reach.**
- `reach`, `{ [machine id]: { reachable: true } | { reachable: false, error } }`, is what the latest attempt on each
  machine found: a use, or a check.
- A `setMachines` checks, in the background, only the machines it adds or changes (another endpoint or another
  pinned key), and `acceptHostKey` checks the machine it trusted. A check is the same open-and-start a use does, then
  `connection.info()`. Every other machine keeps what was found of it, and uses keep that current:
  - the list comes at every connect and with every `RemoteHostRepository` publish;
  - checking an unauthorized machine each time would cost it failed logins, for which OpenSSH 9.8+ refuses A's
    connections for a while, tool calls included (Notes).

  While the conversation is closed (piece 5), the checks still run, so a move there finds its machines ready.
- Accepting a key clears the machine's row ("Checking…") and lets go of a check still in flight, which would
  otherwise end with that key pending again.
- `error` is pi-env's own message, or the host-key message above. A use's failure is also the tool call's result:
  - "ssh 127.0.0.1 failed with exit code 255: vikashloomba@127.0.0.1: Permission denied (publickey)."
  - "ssh 127.0.0.1 failed with exit code 255: ssh: connect to host 127.0.0.1 port 52203: Connection refused"

**Daemons where `packagedDaemon` looks:**
- `binary` can't be chosen after detection. It is one path for whatever system is detected: `options.binary ??
  packagedDaemon(remote)` in both `connectSsh` and the lazy restart (`src/ssh.ts:500-501`, `:536`).
- `packagedDaemon` reads `bin/pi-env-<platform>-<arch>/pi-env` under `new URL("..", import.meta.url)`
  (`src/ssh.ts:57`, `:356-360`). In the single-file bundle that is the bundle folder's parent (measured with esbuild
  0.28.2), so the daemons go to `~/.infinichat/server/bin/pi-env-<target>/pi-env`.
- Install (`install.ts`):
  - **Check:** the bundle check script also prints each daemon that is missing or has the wrong SHA-256.
  - **Upload:** each missing daemon goes up with the bundle's upload script (aside, verified, renamed), loaded and
    verified by the phone's `loadPackagedDaemon`. That is all four the first time (8,560,960 bytes), and only a
    missing or damaged one later.
  - **Cleanup:** the readiness step's cleanup of other bundles' folders keeps `bin/`, which every bundle shares.
- The server never asks for its own daemon: its own device stays `NodeExecutionEnv`.

**Remote machines** (`src/app/remote-hosts/index.tsx`, `useInfiniChatMachines` in `chat-provider.tsx`):
- While InfiniChat runs on a machine, each other machine's section gains a "From <machine>" row: "Checking…",
  "Reachable", "Can’t connect" with pi-env's error below it, or "SSH host key to verify" ("SSH host key changed").
- A key waiting there shows its algorithm and fingerprint with the screen's comparison text, and "Accept verified key
  on <machine>" ("Accept verified replacement key on <machine>"). Not accepting leaves the machine blocked.
- Nothing shows while InfiniChat runs on This iPhone.

## Ownership and lifetime

| Resource | Created by | Closed by |
| --- | --- | --- |
| pi-env `Connection` per machine | the server's devices, on first use | `server/main.ts` at shutdown, after the core (as the phone's provider closes its remote owner after both Harnesses) |
| `RemoteExecutionEnv` per call | the devices | per call; it borrows the connection |
| known_hosts file | `acceptHostKey` | persists |

A call's cancellation stops that call only (pi-env `Connection` semantics). Shutdown closes the connections.

As built:

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| pi-env `Connection` per machine | `ServerMachines`, through `connectSsh`, at the first use or check | — (`connectSsh` takes no signal; its `ssh` runs end within pi-env's 60 s each) | `ServerMachines`: at shutdown (`main`, after the conversation); at once when the phone's list removes or moves the machine; when its start failed |
| The daemon on each other machine | pi-env, at the connection's start | — | `Connection.close()`, which "kills everything it started" (`src/connection.ts:215-216`) |
| `RemoteExecutionEnv` per call | the device | the call's context (pi-env sends `cancel`) | nothing to close; it borrows the connection |
| A scan | the first use of an untrusted key | — | pi-env removes its temporary known-hosts file |
| A pending scan | `open` | — | the phone's accept, a start that works, or a list that drops or moves the machine |
| `~/.infinichat/known_hosts` | pi-env's `acceptHostKey` | — | persists; `forgetHostKey` for a changed key |
| `~/.infinichat/machines.json` | `setMachines` | — | persists |
| `~/.infinichat/server/bin/` daemons | `install.ts` | — | persist across bundles |
| The phone's list on its way | `RemoteInfiniChat` | — | settles; it unsubscribes from Remote machines at `close()` |
| A `connectSsh` still running at shutdown | a use or a check | — (upstream: `connectSsh` takes no signal; each of its `ssh` runs ends within pi-env's 60 s, `src/ssh.ts:123`) | its connection is closed once it resolves; the process waits for those `ssh` runs to end |

A use that is cancelled while its machine connects waits for that connect to end, as the phone's `owner.ts` waits for
`connection.info()`; the connect then serves the next use.

## Deviations (need approval)

- **Automatic acceptance when the fingerprint matches the phone's pinned key.** The owner already compared that key
  out of band when adding the machine. A mismatch always asks.

  *As built, for the owner's review:* this also covers a key that replaced one the server trusted. When the new key
  equals the pin, which the owner accepted on the phone as a replacement, the server runs `forgetHostKey`, then
  `acceptHostKey`, without asking. pi-env's own rule is that a changed key is never accepted without removing the old
  one, and it is removed, automatically.

Found while implementing, against pi-env 1.4.0:

- **`connectSsh` on first use, instead of `sshConnection`,** for its typed host-key errors, and a failed start is let
  go (Builds).
- **The daemons in `bin/` beside the bundle folders,** not passed as `binary` (Builds). This is the spec's fallback.
- **`reach`, and a check of each added or changed machine,** for Remote machines' per-machine status (Builds).
- **One fresh `connectSsh` when a connection that worked fails to restart** (Builds), so a changed key pends at once.
- **`acceptHostKey` takes the fingerprints shown,** so the accept is of the key the owner compared.

## Notes for the owner

- **sshd's penalties for an unauthorized A.** pi-env's detection runs a POSIX probe, then a PowerShell probe after any
  other failure (`src/ssh.ts:329-339`). So A fails to authenticate two or three times per attempt, counting the scan
  of an untrusted key.
  - OpenSSH 9.8 and later (`PerSourcePenalties`) then refuses A's address for about 15 s. Measured on OpenSSH 10.3:
    "activating ipv4 penalty of 15.843 seconds".
  - In that window pi-env's error reads "Connection closed by <B> port <p>" instead of "Permission denied", and
    every account's connections from A to B are refused.
  - A machine is checked when it is added or changed, so a phone connect no longer adds failed logins. A tool call
    naming that machine still does.
- **Auto-accept depends on the key type.** A's `ssh` scans with its own default host-key order (Ed25519 first). A
  machine whose phone pin is another type (react-native-ssh's negotiation) shows as pending once, and the owner
  accepts it from the phone. Only one-key machines were tested.
- **Connections outlive a move back.** They close at shutdown, as specified, so a server whose conversation moved back
  keeps its daemon sessions on the other machines until it next restarts.
- **Shared daemon folder.** pi-env's `deployDaemon` on another machine removes daemons of other contents in
  `~/.pi/mobile/tools/` (`src/ssh.ts:456`), the folder the phone's provisioning uses there. Both deploy the same
  bytes today. If the phone and a server ever ran different pi-env versions, each would remove the other's daemon,
  and each re-uploads at its next start (a running daemon keeps its file).
- **Machines without a pinned key** are listed too, and their key always waits for the phone.
- **Old data.** Servers installed before this piece have no `bin/` and no `machines.json`; the bundle changed, so the
  next connect reinstalls and uploads the daemons. Nothing to clear.

## Size

About 240 lines: machines list and devices ~120, host-key flow ~80, daemon upload ~40.

As built, after the review, +461 −29 lines outside the docs, the asset, its manifest and the lockfile:
- `server/machines.ts` 240, about 50 of them comments;
- `install.ts` +41 −10;
- `client.ts` +50 −5;
- Remote machines +50;
- the contract +30;
- `serve.ts`, `main.ts` and `devices.ts` +31 −11;
- the provider's hook +15;
- `isRecord` and `noop` exported from `state.ts` and `conversation.ts` for reuse.

The growth over the estimate is `reach` and its checks, which the estimate didn't price, the changed-key paths, and
the Remote machines rows. The asset grew from 8,256,566 to 8,332,532 bytes with pi-env's client.

## Checks

- With InfiniChat on a Mac, run a command on a Linux machine whose `authorized_keys` has the Mac's key. Then on a
  machine without it: the error is clear.
- Change a machine's host key: the phone asks; accepting works, refusing keeps it blocked.
- Move back to the phone: the phone's own SSH tools take over, unchanged.

Done in this piece on the implementer's Mac, with no device and no Linux machine. The results are in
[references](references.md#piece-7-on-macos). Machine A was a server under a scratch HOME; the other machines were
disposable `sshd` instances on 127.0.0.1, so they were macOS. Still unverified:

- **On the owner's iPhone:** the Remote machines rows and the accept button, the list sent from the real Keychain,
  and a move back with the phone's own tools afterwards (their code is unchanged).
- **Linux:** a Linux machine as A or as one of the others. `vikash-system` was not touched.
- **macOS A's own agent:** a LaunchAgent server with the owner's real keys or launchd's `SSH_AUTH_SOCK`. The checks
  used a scratch agent.
- **Over Tailscale:** real hostnames and latency.
- **Key variety:** passphrase-protected keys, and machines with several host keys.
