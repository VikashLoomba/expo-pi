# Piece 3: The `Link` seam

## Goal

RemoteInfiniChat's Chord half moves into the package. Each app supplies a *dialer*: how it reaches one machine's
InfiniChat server and gets a Chord `Link` to it. The iPhone keeps today's SSH tunnel as its dialer. The Mac app can
then show its own server over a plain loopback socket, and other machines over whatever SSH it has, with the same
RemoteInfiniChat. Nothing changes on the phone.

## Why this seam

RemoteInfiniChat is a Chord client of a Harness that runs elsewhere. pi-durable's `ExecutionEnv` is for where an
agent's tools run, so it is not this seam ([references](references.md#two-seams-two-questions)). Chord's own seam
for reaching a host is the `Link`:

- `host.connect(link, options)` "Sets (or replaces, after a reconnect) the link to this host's parent; remote
  references re-hold over it" (chord `dist/host.d.ts:171`).
- A held reference stays readable while a link reconnects, and calls on a `loading` reference wait until it is live
  (chord `docs/guide.md:396`, "References").
- `Link` is a small interface: `closed`, `send`, `receive`, `onClose`, `close` (chord `dist/link.d.ts:3-16`).
  `webSocketLink(socket)` makes one from a WebSocket.

RemoteInfiniChat already uses connections this way: one client host, one held reference, a new link after every drop
(`client.ts:283`, `reconnect`). Only how the link is made is host-specific.

## Starts from

`src/pi/infinichat-remote/client.ts` (527 lines):

| Part | Where | Goes to |
| --- | --- | --- |
| Client host, held reference, copied values, the `InfiniChatHost` methods, `call`, `connected`, `resume`, `reconnect`, `close`, `hold`, `refresh`, `sendMachines`, `dropped`, `publishConnection` | most of the file | the package |
| `Session` with the SSH connection and tunnel (`:35`), React Native's header-taking `WebSocket` (`:38-46`) | top | the phone's dialer |
| `connect` (`:361`): restore the machine list, check the machine still exists, read the secret, admit, open SSH, find the running server or install | | the phone's dialer, except the attempt loop |
| `open` (`:408`): tunnel with `forwardLocal` (`:412`), socket with the secret (`:417`), `webSocketLink` (`:420`), `host.connect` (`:423`), wait for `live`, check which server answers | | tunnel and socket to the dialer; `host.connect`, the wait and the check stay |
| `dispose` (`:512`): close the link, the tunnel, the SSH connection | | the dialer's `close` |

## Builds

### In the package: the dialer interface

A sketch. The implementer refines names and fields, keeping today's behaviour.

```ts
/** How one app reaches one machine's InfiniChat server. */
export interface ServerDialer {
  dial(options: {
    signal: AbortSignal;
    /** Progress of an install the dial runs. */
    onStage(stage: InstallStage): void;
    /** The transport under the link went away: the SSH session or its tunnel. */
    onDropped(): void;
  }): Promise<DialedServer>;
}

export interface DialedServer {
  link: Link;
  /** The server this app may use: its bundle, and the device name and description the device list gives it. */
  expected: { bundle: string; device: string; description: string };
  /** The dial installed or updated the server, so a refusal now is final. */
  installed: boolean;
  /** What the install wants the user to know. */
  notice?: string;
  /** Installs or updates the server over the same connection, and returns a new link to it. */
  reinstall(): Promise<Link>;
  /** Closes the link's transport: the tunnel, then the connection. */
  close(): Promise<void>;
}

/** The machine as this app knows it, and the other machines the server's tools reach. */
export interface MachineDirectory {
  name(): string;
  /** As `setMachines` sends them: never credentials, with the host key this app pinned, if any. */
  others(): Promise<Machine[]>;
  subscribe(listener: () => void): () => void;
}
```

`InstallStage` moves from `install.ts` into the package with it. `reinstall` keeps today's behaviour, where a server
that refuses the socket is reinstalled over the same SSH connection (`client.ts:387-390`), instead of a second dial.

### In the package: RemoteInfiniChat

`new RemoteInfiniChat(dialer, directory)`. Its attempt keeps today's order:

1. `dial`.
2. `host.connect(link)`, hold or keep the reference, wait for `live` or the link's close.
3. If the server isn't the expected one, or the socket closed first: if `installed`, fail with today's message;
   otherwise `reinstall()` and go back to step 2 once.
4. Live: `setTimeZone`, then `sendMachines` from `directory.others()`.

`resume()` stays as it is: the phone calls it when the app becomes active, because iOS suspended the pinger and the
SSH keepalive. A Mac app may never need it.

### In the iOS app: the phone's dialer

`src/pi/infinichat-remote/phone-dialer.ts`, built from the code the table above lists:

- `hosts.restore()` and the "removed from Remote machines" check;
- `savedSecret`, `hosts.admit`, `connectAdmitted` with `onDisconnected` → `onDropped`;
- `runningServer`, or `installServer` when there is no secret or no running server of this bundle;
- `forwardLocal` with `onClosed` → `onDropped`, React Native's `WebSocket` with `Authorization: Bearer <secret>`, and
  `webSocketLink(socket)`;
- `expected` from `SERVER_BUNDLE` and `machineDescription(admission.host)`.

`MachineDirectory` over `RemoteHostRepository`: `name` from `hosts.get`, `others` as `sendMachines` builds the list
today, and `subscribe` from `hosts.subscribe`.

`chat-provider.tsx` builds `new RemoteInfiniChat(phoneDialer(hosts, machineId), directory)` where it builds the client
today.

### The Mac app's dialers (for later; not built here)

- **Its own server:** read `port` and `bundle` from `~/.infinichat/server.json` and the secret from
  `~/.infinichat/secret`, then open a socket with `ws` (`new WebSocket(url, { headers })`, as `server/listen.ts`
  accepts them) and pass it to `webSocketLink`. No SSH.
- **Another machine:** a tunnel with the system `ssh` (`-N -L`). Don't reuse pi-env's `sshArguments` for it: those
  arguments disable "forwarding of any kind" by design (pi-env `dist/ssh.d.ts:42-46`). Take the host-key handling from
  pi-env (`scanHostKey`, `acceptHostKey` and their known-hosts file), as `server/machines.ts` does.

## Ownership and lifetime

- **RemoteInfiniChat** creates and closes its Chord client host and its one reference, as today.
- **The dialer** creates each `DialedServer`'s transport (on the phone: the SSH connection and tunnel). RemoteInfiniChat
  closes it through `close()` when the link drops and when it closes. It never touches the transport otherwise.
- **The machine list** is borrowed: `RemoteHostRepository` on the phone, owned by the provider as today.
- **Cancellation:** `close()` aborts the attempt's signal, which the dial receives. A cancelled dial closes what it
  opened. Cancelling an attempt never closes the client host; only `close()` does.

## Deviations (need approval)

None. RemoteInfiniChat takes a `MachineDirectory` instead of `RemoteHostRepository`, because `hosts.ts` imports
react-native-ssh types and SSH admission is the dialer's job; that is internal, and nothing users see changes.

## Size

About 150 of `client.ts`'s 527 lines become the phone's dialer, about 40 lines of interfaces are added, and the rest
moves into the package unchanged.

## Checks

- Lint, typecheck, server typecheck. The server doesn't import the client, so its asset doesn't change.
- On the iPhone Release install, with InfiniChat on vikash-system:
  - Open InfiniChat: the transcript appears and a message gets an answer.
  - Send the app to the background and back: the link is replaced and the transcript stays.
  - Restart the service on the machine (`systemctl --user restart infinichat`): the phone reconnects by itself.
  - Install a new server bundle (any piece that rebuilds the asset): the phone reinstalls once and connects.
  - One move each way.

## Not in this piece

Install and move (piece 4), the Mac app's dialers, and the server's single-client code (piece 7).

## As built

Built in the commit that adds this section, from `86bc596`, with pi 1.4.0 (pi-durable, pi-ai, chord and pi-env; the
latest on npm on 2026-10-26), Expo 58.0.17 and React Native 0.88.0. Chord 1.4.0's contracts were read again at the
installed version: `Link` (`dist/link.d.ts:3-16`), `host.connect` (`dist/host.d.ts:171-174`) and "References"
(`docs/guide.md:396`, `:418`). `client.ts` moved with `git mv` to `packages/infinichat/src/pi/infinichat-remote/`,
and `git` records the rename.

| File | Lines |
| --- | --- |
| `packages/infinichat/src/pi/infinichat-remote/client.ts`: RemoteInfiniChat | 484, from 529 |
| `packages/infinichat/src/pi/infinichat-remote/dialer.ts`: `InstallStage`, `DialOptions`, `ServerDialer`, `DialedServer`, `MachineDirectory` | 48 |
| `apps/mobile/src/pi/infinichat-remote/phone-dialer.ts`: `phoneDialer` and `phoneMachines` | 110 |

What differs from the plan:

- **An install reports its notice through a callback, not two fields.** `DialOptions` has `onInstalled(notice)`, and
  `DialedServer` has no `installed` or `notice`, so `reinstall()` returns only the link, as sketched. Today the notice
  is set and the stage cleared as soon as `installServer` returns (`client.ts:367-374` at `86bc596`), before the tunnel
  opens. Fields on the returned `DialedServer` would arrive only after the tunnel and socket open, so an install
  followed by a failed tunnel would lose its notice (the missing service manager, or the linger advice), and
  `reinstall()` would have to return a notice as well. RemoteInfiniChat treats an attempt as installed once the
  callback runs, the moment today's `installed` flag was set.
- **A reinstall doesn't install over the dial's SSH connection, and never did.** The plan says a refused server is
  reinstalled "over the same SSH connection (`client.ts:387-390`)". In fact `installServer` admits the machine again
  and opens its own connection (`install.ts:319` at `86bc596`), which it disconnects when done (`:394`). Only the
  tunnel uses the attempt's connection. `reinstall` keeps that: it runs `installServer` as before, then closes the old
  link and tunnel and tunnels again over the dial's connection. The plan's intent holds: there is no second dial, so
  no second restore, secret read, admission for the tunnel or `runningServer`. `DialedServer.reinstall`'s comment in
  `dialer.ts` says so, so a Mac dialer may install over a connection of its own too.
- **The dialer's `close` closes the link too.** The sketch's comment says `close` closes "the tunnel, then the
  connection". The "Starts from" table sends all of `dispose` (link, tunnel, connection) to the dialer's `close`, which
  is what it does, because the dialer makes the link. Likewise `reinstall` closes the previous link and tunnel before
  it tunnels again, as `open` did.
- **`MachineDirectory` has an `id`, and `name()` may be undefined.** The provider finds the client by machine
  (`state.remote?.machineId`), and `useInfiniChatMachines` reports `remote.machineId`, so RemoteInfiniChat's
  `machineId` reads `directory.id`. `name()` returns undefined once the machine is gone from this app's list, so the
  fallback "The machine" stays in the package with the messages that use it.
- **`DialOptions` is a named interface;** the sketch writes it inline.

Choices:

- The interfaces are in their own `dialer.ts`, so `install.ts` and the InfiniChat screen import `InstallStage` without
  the client, and the client's imports of other package files are relative, like the other package files'.
- `phoneMachines`, the directory over `RemoteHostRepository`, sits beside `phoneDialer` in `phone-dialer.ts`.
  `others()` is `sendMachines`'s list-building code, moved unchanged.
- Nothing users see changed, including the wording: the client host is still named `phone`, and the refusal still says
  "did not accept this iPhone". The name in it is `expected.device`, the name from the admission, as before. The Mac
  app's piece can reword them.
- RemoteInfiniChat's `dispose` ignores a `close()` that fails, because `dropped` doesn't await it; today's `dispose`
  ignored each step's failure itself. The phone dialer still catches each step, so a failed tunnel close doesn't skip
  the disconnect.
- The comment saying owner.ts's daemon connections aren't used while the machine runs InfiniChat moved to
  `phone-dialer.ts`, beside the SSH connection it describes. Piece 4's check 7 quotes it from `client.ts`.
- Nothing stored is renamed, and the server bundle is byte-identical, so no machine reinstalls and no app data needs
  clearing.

Checks:

- From `apps/mobile`: `npx @expo/agent-cli lint` (exit 0, and `npx expo lint -- --max-warnings 0` is clean),
  `npx @expo/agent-cli typecheck` (no type errors) and `pnpm exec tsc -p server` (no errors). From the root:
  `pnpm --filter @pi-agent/infinichat lint`, 38 files, no problems besides the known warning that React can't be
  detected.
- The server asset, rebuilt in this checkout: 8,352,831 bytes, SHA-256 `668a9eec…3cecff`, the same as piece 2's,
  because the server doesn't import the client. `--check` passes.
- An iOS export with source maps (`npx expo export --platform ios --source-maps`) bundles
  `/packages/infinichat/src/pi/infinichat-remote/client.ts` and `/apps/mobile/src/pi/infinichat-remote/phone-dialer.ts`,
  with one store directory each for chord, pi-ai, pi-durable and pi-telemetry. `dialer.ts` contains only types, so it
  isn't in the bundle.

Unverified: nothing ran on a device. Every device check above is left to the owner's iPhone. The paths that matter
most there are by source assessment only: the notice after an install, a refused server reinstalled once, a drop of
the SSH session or the tunnel while live, and a dial cancelled by `close()`.

## Later (2026-10-29): the return from the background

The owner's phone sat at "Connecting to vikash-system…" after a return from the background until the app was quit.
vikash-system's tailscaled log showed the dial's daemon connection run its cache check and key exchange, then nothing
for 32 seconds. The cause was a cycle with no deadline in it: the daemon connection's start stored the exchanged keys
by patching the conversation's machines document, a call on the InfiniChat reference the client still held from
before the background; Chord lets a call on a loading reference wait for the link with no deadline (`remote.js:295`
at v1.4.0); the link comes back only when the dial finishes; the dial was waiting on the daemon connection. A fresh
process has no held reference, so the same patch fails fast there, which is why a relaunch worked.

- The phone's channel factory no longer awaits the key store (`apps/mobile/src/pi/execution/remote/channel.ts`);
  the record is for the next exchange, and the patch completes on its own once the link is live. The Mac's key exchange
  runs only in its Check connection, not when a dial opens a daemon connection, so it has no cycle.
- `reconnect` tries again after a failure, with the delay pi-env's watcher uses for its daemon (1 s doubling to 30 s,
  `dist/watch.js:105-110`); a failure still shows until the next attempt, and Try Again comes sooner.
- `resume` cancels an attempt that was under way when the app was suspended, so the return from the background never
  waits on a transport that died meanwhile.
