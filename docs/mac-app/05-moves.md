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
