# Piece 4: Machines

## Goal

The Mac keeps its own list of remote machines, reaches them with pi-env, checks them, trusts their host keys on first
use, exchanges InfiniChat keys between them, and tells the InfiniChat server about them. The Settings window appears,
with its Machines pane.

## What upstream does

- **pi-env 1.4.0:** `connectSsh(target, options)` and `RemoteExecutionEnv` as `ServerMachines.environment` uses them
  (`packages/infinichat/src/node/machines.ts:154`), one connection per machine kept open; `SshTarget` carries `host`,
  `user`, `port`, `identityFile`, `knownHostsFile`, `hostKeyAlias`, `configFile`; `strictHostKeys: false` gives
  OpenSSH's `accept-new` (`dist/ssh.js:67`), `HostKeyChangedError` and `HostKeyUnknownError` (`:113-117`),
  `forgetHostKey`, `scanHostKey`, `acceptHostKey`. `loginShell: true` everywhere (owner decision 2026-10-22).
- **The phone's list:** `RemoteHostRepository` (`apps/mobile/src/pi/execution/remote/hosts.ts:164`): unique names,
  `phone` reserved (`:62-64`), `admit`, `setKeys`, `forgetHostKey`, `remove`; `testRemoteHost` (`test-host.ts:61-89`)
  with stages and sanitized errors (`:24-55`); the key exchange `ssh-keys.ts:22-45` running the package's script
  (`keys.ts:18`) at every connect (`channel.ts:124-129`) and keeping `publicKey`/`authorizedKeys` on the record;
  `phoneMachines` (`phone-dialer.ts:126-148`) as the `MachineDirectory`. The screens: `remote-hosts/index.tsx` (268)
  and `edit.tsx` (206).
- **Electrobun:** a second `BrowserWindow` for Settings (`views://app/index.html?window=settings`, its own
  `preload`), `BrowserWindow.getById`, `Utils.openFileDialog` for an identity file, `Utils.showMessageBox` for the
  removal confirmation and unsaved changes.

## Builds

- `src/main/machines.ts`: `MacMachines`: the list in `userData/machines.json` (`id`, `name`, `hostname`, `port`,
  `username`, `identityFile?`, `publicKey?`, `authorizedKeys?`), plus the built-in record for this Mac (`self: true`,
  the computer name, `os.hostname()`, the current user, port 22; hostname editable, so a Tailscale name can replace
  `.local`); `target(machine): SshTarget` with `knownHostsFile = userData/known_hosts` and `hostKeyAlias` = the
  endpoint; `environment(id)` pooling one `connectSsh` + `RemoteExecutionEnv` per machine, `NodeExecutionEnv` for this
  Mac; `check(id)` (connect, detect the system and Node as `installServer` does, exchange keys), with stages and the
  phone's error texts; `HostKeyChangedError` → the record's `pendingKey`, `trustNewKey(id)` = `forgetHostKey` and
  check again; `remove(id)` after `removeClient(env, macClient().id)` (`install.ts:378`) where the Mac has a
  secret; `close()`.
  Removing a machine that holds the conversation is refused: "Move InfiniChat to another machine first."
- `src/main/keys.ts`: the phone's `KeyExchange` over an `ExecutionEnv` (`ssh-keys.ts` without react-native-ssh), run
  by `check` and at every environment open.
- `src/main/directory.ts`: `macDirectory(machines, id): MachineDirectory` as `phoneMachines`, `others()` without
  `hostKey` (each server pins on first use itself, docs/infinichat-package piece 7 "As built").
- `src/contract.ts`: `MacMachines` (input `{}`): cells `machines` (the records, never a key's contents), `checks`
  (per id: stage, result, error, pending key); methods `save`, `remove`, `check`, `cancelCheck`, `trustNewKey`,
  `pickIdentityFile` (file dialog, returns the path).
- `src/main/serve-machines.ts`; `src/main/settings-window.ts` (one window, shown by `⌘,`, `getById` to reuse it).
- `src/view/settings.tsx`: the Settings root with a source list (Machines; Providers in piece 8); `machines.tsx`: the
  list (name, endpoint, identity, check result, pending key with Trust new key, Check connection with progress and
  cancel, Edit, Remove with confirmation) and the form (Name, Hostname, Port, Username, Identity: your SSH setup or a
  file), Save then Check as the phone does (`edit.tsx:98-134`), unsaved changes confirmed.

## Ownership and lifetime

`MacMachines` owns its connections and closes them at quit after the Harnesses and the InfiniChat clients, as the
phone closes `remote` last (`chat-provider.tsx:270-273`). The known-hosts file is the app's, under `userData`.

## Deviations

4 (keys, no passwords).

## Size

About 600 lines: store and pool 180, keys 40, directory 40, contract and serve 90, Settings window 40, screens 210.

## Checks

- Add vikash-system by name with the user's SSH setup: Check reaches it, reports Node, exchanges keys; `known_hosts`
  gains its key; a changed key shows Trust new key and recovers after it.
- The InfiniChat server on this Mac lists the machine (`machines.json` there has the Mac's client ID) and its tools can
  reach it; the phone's list is untouched.
- Remove deletes the Mac's client file on the machine; removing the holder is refused.

## Not in this piece

Reaching another machine's InfiniChat and moving (5), "From <machine>" reachability and host-key acceptance (5).
