# Piece 5: Moves

## Goal

The window shows InfiniChat on whichever listed machine holds it, follows it when the phone moves it, and moves it from
one machine to another with the Mac orchestrating.

## What upstream does

- **The dialer over SSH:** `phone-dialer.ts:85-98` tunnels with `forwardLocal` and opens the socket on the local
  port. pi-env has no tunnel API and its `sshArguments` (`dist/ssh.js:43-73`) bans forwardings; OpenSSH's `-W
  host:port` forwards the client's stdio to the machine's loopback instead, and `ws`'s client takes a
  `createConnection` option that supplies the socket.
- **Moves:** `InfiniChatMoves` (`move.ts:319`): `between` (`:555-591`) connects to the target, authorizes its key on
  the source (`:598-612`), `relinquish`, `pull`, `adopt`, `archive`; `choose`, `cancel`, `retry`, `resume`, `close`;
  what the host supplies (`:337-341`, `MoveSides` `:58-72`). The phone wires it at `chat-provider.tsx:155-183` and
  shows it in the machines menu (`(infinichat)/index.tsx:218-250`) and the move banners (`:256-276`).
- **Where it went:** the server's `conversation` cell carries `heldBy`, a phone or a machine by endpoint
  (`contract.ts:50-62`), so a client that connects to a machine that no longer holds it learns who does.

## Builds

- `src/main/tunnel.ts`: `tunnel(target, port)` spawns `ssh` with pi-env's `sshArguments(target, false,
  knownHostsFile)` (host keys, identity, batch mode: pi-env's own) and `-W 127.0.0.1:<port>`, returns a `Duplex` over
  the child's stdio and a `close`; the child's exit is the dial's `onDropped`. It is the Mac's counterpart of the
  phone's second SSH connection and `forwardLocal`. If `-W` is refused under `ClearAllForwardings` or `ws` won't take
  the stream, `-L` to a port the app picks (deviation 6).
- `src/main/dialer.ts` gains the other machines: environment from `machines.environment(id)`, `installServer`
  through it (the pi-env daemons uploaded from the app's assets), the socket over the tunnel.
- `src/main/infinichat.ts`: `InfiniChatMoves(home, directory, environment, undefined, 'this Mac', SERVER_BUNDLE,
  sides)` with `machine`, `show`, `closeMachine`, `hold`; following `heldBy`: when the shown server reports
  `active: false` with `heldBy` a listed machine, the home record moves there and the app connects to it; an unlisted
  machine or a phone shows "InfiniChat is on <name>"; `moves.resume()` at launch.
- `src/contract.ts`: `MacInfiniChat` gains cells `move` (`MoveStatus` and the notice), `reach` and
  `pendingHostKeys` (from the shown server), and methods `chooseMove({ machineId })`, `cancelMove`, `retryMove`,
  `dismissMoveNotice`, `acceptHostKey`.
- `src/view/infinichat.tsx`: the machines pull-down in the toolbar (each listed machine with a checkmark on the
  holder, Cancel Move, Add Machine…, Manage Machines… opening Settings), the move subtitle and banners with Retry
  and Cancel; `machines.tsx`: "From <holder>" reachability and Accept for pending keys
  (`remote-hosts/index.tsx:156-188`).

## Ownership and lifetime

The tunnel child belongs to the dial and ends with `close`; the dial closes it before the SSH environment pool, which
stays open for the chats' tools (piece 4). A move stops where it is at quit; `resume` carries it on at the next launch,
as on the phone.

## Deviations

1 (`files` and the phone-side `MoveSides` members optional in the package: ~10 lines in `move.ts`), 6 (the tunnel).

## Size

About 400 lines: tunnel 60, dialer additions 50, moves and following 100, contract and serve 60, menu and banners 130.

## Checks

- With InfiniChat on vikash-system (moved there from the phone): the Mac connects through the tunnel and shows the
  live transcript; sends work; a dropped SSH session reconnects.
- Move it from vikash-system to this Mac and back from the Mac's menu, with the phone watching: the phone's screens
  follow ("on <machine>"), the step banners show, Cancel undoes mid-way.
- Move it from the phone to the other machine while the Mac shows it: the Mac follows within one connection.
- Move it back to the phone from the phone: the Mac shows "on <phone>".

## Not in this piece

Scheduled tasks on the holder, settings and providers (6).

## As built

From `6dc6028` on `feat/mac-app-shell` (2026-10-28), one commit. What differs from the plan:

- **The tunnel is a loopback listener**, not a `Duplex` handed to `ws`: each connection to the local port is one
  `ssh -W 127.0.0.1:<port>` whose stdio is piped to the socket, so `ws` gets an ordinary TCP socket. pi-env's
  `sshArguments` end with `--` and the host; the forwarding goes before them (the first build put it after, which
  made the remote shell run `-W` as a command). A connection's `ssh` exiting is the dial's `onDropped`; its last
  stderr line goes to the log.
- **`ws` socket errors are handled** in both dialers: a failed connection emitted an unhandled `error`, which ended
  the Bun process.
- **This Mac is named by its endpoint everywhere**, as every machine is: `thisMac` carries
  `machineEndpoint(hostname, 22, user)`, the home record seeds with it, `MacMachines.isSelf` also accepts the
  document's spelling under this Mac's name, and `macDirectory(machines, id)` gives each machine's record. The
  `mac` ID is gone; the dev home record on this Mac was removed to reseed.
- **`InfiniChatMoves` without local files** (deviation 1): `files` is optional, the paths to or from "this device"
  throw, `arrived` and `refresh` skip the copy; the Mac's `MoveSides` reject `closeLocal` and `openLocal`.
- **Following the holder** lives in `MacInfiniChat.follow`: when the shown server reports `active: false` with a
  listed `heldBy`, the home record moves there and the app connects to it; a phone shows as the holder.
- The machines menu is a dropdown in the conversation header (lucide's server icon), with the check on the holder,
  Cancel Move while cancellable, and Add Machine… and Manage Machines… opening Settings through `MacApp.openSettings`.

Verified on 2026-10-28: the Mac moved InfiniChat to vikash-system (installing the server there through the Mac's own
SSH and reaching it through the tunnel) and back, with the subtitle through the steps; the phone followed. The move
copies the whole file, which docs/infinichat-package piece 9 changes. Not verified: Cancel mid-way, a dropped SSH
session reconnecting, and following a move the phone makes while the Mac shows the conversation.
