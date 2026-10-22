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

## Builds

- **Which machines.** The phone tells the server the other configured machines: `{ id, name, hostname, port,
  username, hostKey }` from its records, with the pinned key's algorithm and fingerprint. It never sends credentials.
  This happens with `setMachines` on every connect and whenever Remote machines change. The server keeps the list in
  `~/.infinichat/machines.json`, so its tools work while the phone is away.
- **Devices on the server.** This machine (piece 1), plus each listed machine as a `RemoteExecutionEnv`:
  - One `sshConnection` per machine, with `knownHostsFile: ~/.infinichat/known_hosts` and `hostKeyAlias:
    <machine id>`.
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

## Ownership and lifetime

| Resource | Created by | Closed by |
| --- | --- | --- |
| pi-env `Connection` per machine | the server's devices, on first use | `server/main.ts` at shutdown, after the core (as the phone's provider closes its remote owner after both Harnesses) |
| `RemoteExecutionEnv` per call | the devices | per call; it borrows the connection |
| known_hosts file | `acceptHostKey` | persists |

A call's cancellation stops that call only (pi-env `Connection` semantics). Shutdown closes the connections.

## Deviations (need approval)

- **Automatic acceptance when the fingerprint matches the phone's pinned key.** The owner already compared that key
  out of band when adding the machine. A mismatch always asks.

## Size

About 240 lines: machines list and devices ~120, host-key flow ~80, daemon upload ~40.

## Checks

- With InfiniChat on a Mac, run a command on a Linux machine whose `authorized_keys` has the Mac's key. Then on a
  machine without it: the error is clear.
- Change a machine's host key: the phone asks; accepting works, refusing keeps it blocked.
- Move back to the phone: the phone's own SSH tools take over, unchanged.
