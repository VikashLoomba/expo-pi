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
