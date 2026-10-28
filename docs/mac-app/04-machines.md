# Piece 4: Machines

## Goal

The Settings window appears with its Machines pane: the machines of InfiniChat's conversation, as the holder serves
them, with what the holder found of each, host keys to trust, and the Mac's own way of reaching each one. The Mac
puts itself in the list, so a server can name it and reach it.

Depends on docs/infinichat-package piece 8, which makes the list a document of the conversation.

## What upstream does

- **The list is a document** served by the holder as the `machines` cell, edited with `putMachine`, `patchMachine`
  and `removeMachine`, with `reach` and `pendingHostKeys` beside it (docs/infinichat-package piece 8; pi-durable
  `README.md` "Your Own State", `test/examples/04-chord-state.ts`). The Mac is one client of it, as it is of the
  transcript (piece 2), so the pane is a view of cells and its edits are calls.
- **Reaching a machine from the Mac:** pi-env's `connectSsh(target)` and `RemoteExecutionEnv` as `ServerMachines`
  uses them (`packages/infinichat/src/node/machines.ts`), with `SshTarget`'s `identityFile`, `knownHostsFile` and
  `hostKeyAlias`; `strictHostKeys: false` is OpenSSH's `accept-new` (`dist/ssh.js:67`); `HostKeyChangedError`
  (`:113-117`). The Mac's own SSH setup reaches a machine by default (deviation 4).
- **Electrobun:** a second `BrowserWindow` (`views://app/index.html?window=settings`, its own `preload`),
  `BrowserWindow.getById`, `Utils.openFileDialog` for an identity file, `Utils.showMessageBox` for removal.
- **The phone's screens** (`remote-hosts/index.tsx`, `edit.tsx`) after piece 8: Hostname, Port, Username and the
  credential; the machine names itself when it connects (`machineIdentity`).

## Builds

- `src/main/machines.ts`: `MacMachines`: this Mac's record (its computer name from `macClient`, `os.hostname()`,
  the current user, port 22; the hostname editable, so a Tailscale name can replace `.local`), put into the document
  whenever InfiniChat is reached and the record differs; the identity file chosen for a machine, by endpoint, in
  `settings.json` (nothing else is per Mac); `target(record): SshTarget` with `knownHostsFile = userData/known_hosts`
  and `hostKeyAlias` the endpoint; `environment(endpoint)` pooling one `connectSsh` + `RemoteExecutionEnv` per
  machine for the dialer (piece 5) and the key exchange; `check(endpoint)`: connect, `machineIdentity`, the key
  exchange (`keys.ts`), then `patchMachine` with the name and keys, with the phone's stages and error texts;
  `HostKeyChangedError` → the pending key, `trustNewKey(endpoint)` = `forgetHostKey` and check again; `remove`
  after `removeClient(env, macClient().id)` where the Mac has a secret, then `removeMachine`; `close()`.
  Removing the holder is refused: "Move InfiniChat to another machine first."
- `src/contract.ts`: `MacMachines` (input `{}`): cells `machines` (the document's state, relayed), `reach`,
  `pendingHostKeys` (relayed), `checks` (per endpoint: stage, result, error, pending key), `identities` (per
  endpoint, the identity file's path); methods `save`, `remove`, `check`, `cancelCheck`, `trustNewKey`,
  `acceptHostKey` (relayed), `pickIdentityFile`.
- `src/main/serve-machines.ts`; `src/main/settings-window.ts` (one window, `⌘,`, `getById` to reuse it).
- `src/view/screens/settings.tsx`: the Settings root with a source list (Machines; Providers in piece 8);
  `components/settings/machines.tsx`: the list (name, endpoint, identity, reach, pending key with Trust new key,
  Check connection with progress and cancel, Edit, Remove with confirmation) and the form (Hostname, Port, Username,
  Identity: your SSH setup or a file), Save then Check as the phone does; unsaved changes confirmed. While InfiniChat
  is neither on this Mac's server nor reachable, the pane shows the last list and says edits wait.

## Ownership and lifetime

`MacMachines` owns its connections and closes them at quit after the InfiniChat clients, as the phone closes `remote`
last. The known-hosts file and the identity choices are the app's, under `userData`. The list is the conversation's.

## Deviations

4 (keys, no passwords).

## Size

About 420 lines: machines and identities 150, contract and serve 70, Settings window 40, screens 160.

## Checks

- Add vikash-system by hostname with the user's SSH setup: Check reaches it, names it, exchanges keys;
  `known_hosts` gains its key; a changed key shows Trust new key and recovers after it.
- The phone shows the machine the Mac added, and the Mac the phone's; the holder's tools reach both.
- Remove deletes the Mac's client file on the machine; removing the holder is refused.
- This Mac appears in the phone's list under its computer name once the Mac has reached InfiniChat.

## Not in this piece

Reaching another machine's InfiniChat and moving (5), "From <machine>" reachability (5).
