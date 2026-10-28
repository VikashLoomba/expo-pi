# Piece 7: Chats

## Goal

The Mac has its own ordinary chats, as the phone has: a list, a transcript with tools, model and execution settings,
working directories on this Mac or on a machine.

## What upstream does

- **The service:** `DurableChatService.open` (`packages/infinichat/src/pi/chat-service.ts:69-90`): `storage`,
  `models`, `images`, `local.environment(id, cwd)` and `remove`, `machines.environment(id, cwd)`, `newChat`,
  `authError`, `onClosed`, `observe`; methods `createChat`, `send`, `cancel`, `steerQueued`, `retryParked`,
  `updateSettings`, `updateExecution`, `rename`, `delete`, `view(id)` (`:249-392`). The phone opens it at
  `chat-provider.tsx:193-213` with expo-sqlite and the just-bash sandbox; the Node implementations are
  `openNodeSqliteStorage` (`apps/mobile/server/conversation.ts:231`), `createPhotonImages(photon)` and
  `NodeExecutionEnv({ cwd })` (`node/devices.ts:21-25`). The owner decided (docs/infinichat-package piece 6) that the
  Mac's local environment is a folder per chat with `NodeExecutionEnv`, as pi-durable's example 29.
- **Models and credentials:** `createServerModels(credentials)` (`node/models.ts:13`), `ProviderCredentialStore` over
  `fileCredentialBackend` (`apps/mobile/server/main.ts:58-62`), `registerBunOAuthFlows()` (`:37`).
- **Screens:** `chats/index.tsx` (155: list, search, account button, new chat, row menus), `chats/chat/[id].tsx`
  (201: send, stop, photos, Send as steer, parked banner with Resume), `chat-settings/[id]/*` (model, execution
  picker, working directory, directory browser `remote-directory-picker.tsx:46-91`, choose folder), `chat-actions.tsx`
  (rename, delete with confirmation). `NEW_CHAT_DEFAULTS` (`apps/mobile/src/pi/models.ts:19-29`).
- **Electrobun:** `ContextMenu.showContextMenu` from the main process after the page prevents `contextmenu`;
  `Utils.openFileDialog({ canChooseDirectory: true })` for a local folder; `Utils.showMessageBox` for delete.

## Builds

- `src/main/account.ts`: the Mac's `ProviderCredentialStore` over `secrets.ts`'s backend, `createServerModels`,
  `registerBunOAuthFlows`, `authError` (`chat-provider.tsx:102`). The sign-in UI waits for piece 8.
- `src/main/chats.ts`: `DurableChatService.open({ storage: openNodeSqliteStorage(userData/chats.db), models,
  images: the processor of `src/main/images.ts` (piece 1), local: { environment: (id, cwd) => new NodeExecutionEnv({ cwd: cwd ??
  folder(id) }), remove: rm -rf folder(id) }, machines: { environment: (id, cwd) => machines.environment(id, cwd) },
  newChat: NEW_CHAT_DEFAULTS, authError, onClosed: reopen after a storage failure })`, with the phone's `open()`
  sequencing (`chat-provider.tsx:184-214`) and `openError`. Chat folders live under `userData/chats/<id>`.
  `openNodeSqliteStorage` is pi-durable's own export (`@earendil-works/pi-durable/storage/sqlite/node`), which the
  server calls too; `NEW_CHAT_DEFAULTS` moves into the package (`pi/new-chat.ts`) so the phone and the Mac share it
  (deviation 2's list). Neither touches the server bundle.
- `src/contract.ts`: `MacChats` (input `{}`: cells `chats`, `openError`; methods `createChat`, `rename`, `delete`,
  `showMenu({ id })` for the row's context menu) and `MacChat` (input `{ id }`: cells `snapshot`, `controls`,
  `messages`, `status`; methods `send`, `cancel`, `steer`, `retryParked`, `updateSettings`, `updateExecution`,
  `listFolder`, `searchFolders`, `chooseLocalFolder`). `serve-chats.ts` mirrors `service` and each `view(id)` as
  `serve.ts` mirrors the core; a `MacChat` object lives while a window holds it and releases the view with it.
- `src/view/chats.tsx` (the sidebar's chat rows with search, New Chat from `⌘N`, context menu Rename/Delete/Model
  settings, the empty state with suggestions and the Connect a provider card), `chat.tsx` (piece 3's transcript and
  composer with Send as steer while busy, the parked banner with Resume), `chat-settings.tsx` (a sheet: model section,
  Execution: This Mac or a machine, Working directory, Choose folder… (local dialog, or the machine's directory
  browser with search), Refresh models, Cancel and Save calling `updateExecution` or `updateSettings`,
  `chat-settings/[id]/index.tsx:71-89`).

## Ownership and lifetime

The service opens at launch and closes at quit before the machine pool, as the phone's teardown orders it
(`chat-provider.tsx:258-278`). Each chat's folder is removed with the chat. A `MacChat` object is per window hold;
the service outlives it.

## Deviations

A move into the package (the new-chat defaults). Deviation 1 of docs/infinichat-package piece 6 stands:
the local environment is a real folder, not a sandbox.

## Size

About 800 lines: service and account wiring 120, contract and serve 180, sidebar and chat 250, settings and
directory browser 250.

## Checks

- Create, rename, delete chats; send with tools on this Mac (files appear under the chat's folder) and on
  vikash-system with a working directory chosen in the browser; stop, steer, resume a parked chat after a relaunch.
- Photos in a chat; model and effort changes take effect on the next send; a provider without credentials shows the
  Connect notice.
- The chats database survives relaunches under `~/Library/Application Support/com.vikashloomba.piagent.mac/stable/`.

## Not in this piece

Sign-in on the Mac (8).
