# Piece 8: The machines document

## Goal

The list of machines becomes state of InfiniChat's conversation: one pi-durable document in its storage, which every
client reads as Chord state from whichever side holds the conversation and edits through that side, and which moves
with the database. Today each app keeps its own list and sends it to the server at every connect, and the server
merges the lists into `machines.json`; the Mac app was about to add a third copy. A client keeps only what pi-durable
cannot hold for it: its own SSH credential for each machine.

## Owner decision (2026-10-28)

Shared state lives in the Harness's storage as a document, as pi-durable has it, not in per-client stores pushed to the
server. The server bundle and the contract change for it, and the phone gets another Release install.

## What upstream does

- **Documents are the app's state.** "Documents are typed JSON objects committed together with entries" (pi-durable
  `README.md` "Your Own State"): `defineDoc` with `kind`, `version`, `initial`, `migrate` and `checkpointWhen`, edited
  with `tx.doc(Token)` in a commit (`test/examples/01-documents.ts`), observed as Chord state with `documentState`
  (`04-chord-state.ts`) or `watchDoc` (`05-watches.ts`).
- **A session document is one per storage.** `scope: 'session'` (`dist/types.d.ts:44-47`); `tx.doc(SessionDocToken)`
  (`:877`), `watchDoc`, `snapshot` and `documentState` take it without a conversation (`:920`, `:954`, `:960`), and
  `Harness extends Session` (`dist/harness/types.d.ts:723`), so the Harness the service opens commits and observes
  it. `documentState()` "never creates a document" (`04-chord-state.ts`); `tx.doc()` creates it on first use.
- **Many clients, one Harness.** Clients attach to one Harness through Chord and a late joiner starts from the current
  view (`README.md` "Watching a Conversation", `21-late-join.ts`); storage has one owner process (`README.md:790`).
  The server is that Harness, and the apps are its clients (docs/infinichat-package piece 7).
- **Our own documents** already follow this: `AppDoc`, `ConfigDoc`, `ChatMetadataDoc`, `ExecutionTargetDoc`
  (`packages/infinichat/src/pi/infinichat/app.ts:87`, `summary.ts:22`), served as cells through `documentState`
  (`infinichat-view.ts:154-156`), and `ScheduledTasks` as a store over the task graph (`infinichat-scheduled.ts:25`).

## What the app does instead

| Today | Where | Problem |
| --- | --- | --- |
| The phone's list in expo-sqlite's kv-store under one key, credentials in the Keychain | `apps/mobile/src/pi/execution/remote/hosts.ts:164`, `host-storage.ts` | Per client; 300 lines of hand-written validation and journaling |
| Each client sends its list at every connect; the server keeps the lists by client in `machines.json` | `client.ts:464`, `node/machines.ts:95-130` | A copy per process; a machine added on one device is unknown to the other until both have connected |
| The pinned host key and the exchanged keys ride along in each client's list | `MachineSchema` | Trust decided per client, sent as a copy |
| The Mac was to keep `userData/machines.json` | docs/mac-app/04-machines.md (before this piece) | A third copy |

## Builds

### The document

`packages/infinichat/src/pi/infinichat-remote/machines.ts`:

```ts
export type MachineRecord = {
  name: string; hostname: string; port: number; username: string;
  /** The machine's InfiniChat key, as the key exchange read it there. */
  publicKey?: string;
  /** The other machines' InfiniChat keys authorized there. */
  authorizedKeys?: string[];
  /** The SSH host key a client accepted for it: trust on first use, decided once. */
  hostKey?: { algorithm: string; fingerprint: string };
};
export type MachinesState = { machines: Record<string, MachineRecord> };   // by endpoint
export const MachinesDoc = defineDoc<MachinesState>({
  kind: 'infinichat.machines', version: 1, scope: 'session', checkpointWhen: () => true,
  initial: () => ({ machines: {} }),
});
```

Keyed by `machineEndpoint` (`username@hostname:port`), as the server already keys machines and as `heldBy` names
one. Never a credential. The phone's device name stays reserved on the phone (`PHONE_DEVICE`).

### The service

`InfiniChatService` (`infinichat-service.ts`) gains `machines: Store<MachinesState | undefined>`, a `MachineList`
over `harness.documentState(MachinesDoc)` as `ScheduledTasks` is over the task graph, and three methods, each one
`harness.commit` with `tx.doc(MachinesDoc)`:

- `putMachine(record)`: adds or replaces the record at its endpoint. A name another endpoint has is refused
  ("<name> is already the name of another machine."), as `hosts.setName` refuses it today, since the device list
  names devices.
- `patchMachine(endpoint, patch)`: the key exchange's keys, the machine's own name, an accepted host key.
- `removeMachine(endpoint)`.

`open` touches the document once (`tx.doc` in the commit that already migrates `AppDoc`), so `documentState` finds it.

### The server

- `ServerMachines` (`node/machines.ts`) takes the list from the open core's `machines` store instead of
  `machines.json`: it subscribes when a core opens, and the body of `set` (drop the connections of endpoints gone,
  keep what was found of machines unchanged, check the new ones) runs on each change. `readLists`, `merged`, `isMachine`
  and the file go. Between holds there is no list; the tools run only while the Harness is open.
- `acceptHostKey` records the accepted fingerprint with `patchMachine`, so the next holder trusts the same key.
- `pull` takes the source as a record, `pull({ from: MachineSchema, files })`, since it runs while the conversation is
  closed here: the client has the record from the source's cell. `environment(machine)` takes the record.

### The contract

`InfiniChatRemote` version 4: the cell `machines: Type.Union([MachinesStateSchema, Type.Null()])` (null while the
machine doesn't hold the conversation), methods `putMachine(MachineSchema)`, `patchMachine({ endpoint, patch })`,
`removeMachine({ endpoint })`; `setMachines` goes, `pull` changes as above. `MachineSchema` stays the record's shape.
`serve.ts` mirrors the store as it mirrors `scheduled`; `RemoteInfiniChat` gets `getMachines` and the three calls.

### The phone

- `RemoteHostRepository` becomes `RemoteCredentials`: the Keychain records only (`auth`, and the pinned host key,
  which react-native-ssh's `hostKeyPolicy` needs locally), keyed by endpoint; `restore`, `admit`, `save`, `remove`,
  `forgetHostKey`. The kv-store index, `namespaceId`, `pendingDelete`, `setName` and `setKeys` go.
- The screens read the document through `ShownInfiniChat`, which shows the phone's own service or the machine's
  client, with `machines` beside `scheduled`: Remote machines lists it; Save writes the credential, then `putMachine`
  on the shown side; Test connects with the credential and `patchMachine`es the name and keys the exchange found;
  Remove removes the credential and `removeMachine`. While InfiniChat is neither held here nor reachable, the screen
  says so and offers no edit: the list lives with the conversation.
- `phoneMachines` (the `MachineDirectory`) and `infinichat-phone-devices.ts` read the document; a machine's ID in the
  app is its endpoint, so the home record's `machineId` is an endpoint too. The credential index goes to version 2
  at its first load (endpoint IDs; the names and keys it held are the document's now) and keeps the IDs version 1
  gave the records, so a chat's execution target from before still resolves; the home record is rewritten by
  endpoint before anything reads it, from the version 1 index. The document starts empty: Check connection on each
  machine adds it with its name and keys, as the list says of a credential without a record.
- `ssh-keys.ts`'s `KeyExchange` reads the others' keys from the document and stores through `patchMachine`.

## Ownership and lifetime

The document belongs to the conversation's storage and moves with it. The holder's Harness commits it; clients read
it through the holder and edit it through the holder's methods. A client's credentials are its own, in its Keychain or
key files, and outlive the conversation's travels. `ServerMachines` still owns the SSH connections of the machine it
runs on and closes them at shutdown after the conversation.

## Deviations

None from upstream. From the product as built: edits need InfiniChat open or reachable (above).

## Size

Package ~220 lines (document 40, service store and methods 70, server 60 changed with ~80 removed, contract and
client 50). Phone ~350 changed, ~250 removed (the repository shrinks to credentials; the screens change their reads
and writes; two migrations ~60). Server bundle and contract version change.

## Checks

- Add a machine on the phone while it holds InfiniChat; move InfiniChat to the Mac; the Mac shows the machine, and
  the server's tools reach it. Add one on the Mac; the phone shows it. Remove on either.
- Test connection on the phone records the machine's name and keys in the document; a host key accepted on one
  device is trusted by the next holder without a prompt.
- A move between two machines pulls with the record from the source's cell.
- The phone's existing machines appear after the update with their names, credentials and chats' targets intact.

## Not in this piece

The Mac's Settings window and its machines pane (docs/mac-app piece 4), which read this document.

## As built

From `239e476` on `feat/mac-app-shell` (2026-10-28), with pi 1.4.0; one commit. What differs from the plan:

- **The chats' execution targets are not migrated.** pi-durable's `migrate` is synchronous and cannot read the
  phone's old list, so `ExecutionTargetDoc` keeps the ID version 1 gave a machine, and the credential index's
  version 2 keeps a `legacy` map from those IDs to endpoints, which `RemoteHostRepository.get` resolves. The home
  record is rewritten by endpoint at its first read, through the version 1 list or that map, and stored at once.
- **The document starts empty.** Nothing imports the phone's old names and keys; Check connection on a machine lists
  it under its host name before connecting, so the connection's key exchange has a record to keep the keys on, then
  names it. The first version listed it after connecting and lost the exchange's keys on a machine's first check.
- **The secret's Keychain key encodes the endpoint.** expo-secure-store refuses `@` and `:` in a key, so
  `pi.infinichat.secret.v1.<id>` writes them as `_`; the phone makes a new secret and client file for each machine
  at its next connect, and the old ones stay behind unused.
- **The server applies the list only when the document changes**, not at every change of the conversation it
  follows.
- `pull` takes the source's record; `ServerMachines.follow` replaces `set`, `readLists` and `machines.json`;
  `MachineDirectory` gives one `machine()` record; `InfiniChatHost` gains `machines` and the three edits.

Verified on 2026-10-28 with the conversation on this Mac: the server creates the document at its first open; the
phone, updated, migrates its home record and credential index, connects, and Check connection adds both machines by
name; the document moves nothing yet, but this Mac's server reaches vikash-system with its own InfiniChat key, as its
tools do. The first phone install launched the app once before the home record's rewrite was stored, which converted
the index and left the record by the old ID; the `legacy` map covers that too. Not verified: a move with the
document (between machines, and back to the phone), removal from the list, and a machine added on the Mac, which
docs/mac-app piece 4 brings.
