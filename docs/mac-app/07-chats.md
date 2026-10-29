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

## As built

From `4bd7ba8` (2026-10-29), one commit, with pi 1.4.0, Electrobun 2.0.5 and shadcn 4.23 (`context-menu` added with
the CLI). What differs from the plan:

- **Nothing to move for storage.** `openNodeSqliteStorage` is pi-durable's own (`storage/sqlite/node`), which the
  server already imports directly; the Mac does the same (`src/main/chats.ts`). `NEW_CHAT_DEFAULTS` moved to
  `packages/infinichat/src/pi/new-chat.ts`; the phone's copy in `apps/mobile/src/pi/models.ts` stays until its
  import is switched, since `apps/mobile` was outside this piece.
- **The local root is the host's.** `validateExecution` and `executionSettings` (`execution/document.ts`) take a
  `LocalRoot`: `/workspace` by default, the phone's sandbox, inside which every local directory lies and which stands
  for an unset one; `null` on the Mac, where a chat runs in a real folder, so an unset directory is the chat's own
  folder under `userData/chats/<workspace id>` and any absolute folder may be chosen. `DurableChatService.open({ local:
  { root } })` hands it to its `ChatView`s and to `updateExecution`. Without it the phone's rule refused every Mac
  folder, and a chat switched back to This Mac got `/workspace` as its directory.
- **The thread takes its source from a context** (`components/chat/thread-source.ts`): the view's three cells as
  `MacInfiniChat` and `MacChat` both serve them, plus the optional `steerQueued`; a reference to either object is a
  source as it is, so `Transcript` reads `useThreadSource()` and the InfiniChat screen provides its reference.
  `message-row.tsx` offers Send as steer on a queued follow-up when the source has it. The draft and photo handling of
  the InfiniChat screen became `hooks/use-draft.ts`, which both screens use.
- **The row menu is shadcn's `ContextMenu`**, not Electrobun's: Rename needs a text field and Delete a confirmation,
  both in the window, as piece 10 moved the Machines removal there; `MacChats` has no `showMenu`. The rows are
  `SidebarMenuButton`s under a `SidebarInput` search, New Chat is the group's `SidebarGroupAction` and `⌘N`, and the
  Connect a provider card opens Settings (its Providers pane is piece 8). Rename and Delete are the window's dialogs
  (`chat-actions.tsx`); a shown chat that is deleted sends the window back to InfiniChat, as the phone goes back to
  its list.
- **`MacChats`' cell is `report`**, not `openError`: Chord reserves `error` on references. It carries a failed open,
  else the Harness's latest report, as `MacInfiniChat.snapshot.report` does.
- **`MacAccount` exists now** with what the chats need of piece 8's object: `catalog`, `access`, `refreshCatalog`,
  over `src/main/account.ts` (the credential store, `createServerModels`, `authError`). `registerBunOAuthFlows` waits
  for piece 8 with its caller, `models.login`.
- **`MacChat` also fits photos** (`pickPhotos`, `attach`) to the chat's model with the same `Attachments` as
  `MacInfiniChat`, since the composer is the same.
- **Folder listing and search** are `src/main/folders.ts` over any `ExecutionEnv` (the phone's `owner.ts`), reached
  through `MacMachines.environment(endpoint, signal, cwd?)`, which gained the chat's working directory. The browser's
  path helpers are the phone's, in `directory-browser.tsx`.
- **The settings sheet is a `Dialog`** with `Select`s for provider, model, reasoning effort and environment, the
  working directory field, Choose Folder… (the open dialog for This Mac; for a machine the directory browser opens in
  the sheet in place of the button), Refresh Models, Cancel and Save.

Size: about 1,350 lines of our own code (the copied `context-menu.tsx` aside) against the plan's ~800: the thread
seam, the draft hook and the dialogs that stand in for the phone's system alerts were not planned, and the sheet with
its browser is ~420 for the plan's 250.

Verified on this Mac (2026-10-29): typecheck and lint of `apps/mac` and `packages/infinichat`, the server's and the
phone's typechecks, the dev build; the app launches with the chats open (`chats.db` appears in its `dev/` data
folder) with nothing reported by the main process or the window's console. Not verified, because this session could
not drive the window (macOS refused it keystrokes and screenshots): creating, renaming and deleting a chat, the
context menu, the settings sheet and the directory browser, sending with tools on this Mac and on a machine, stop,
steer, photos, and a parked chat's Resume. A send also needs a provider credential in the app's `credentials.json`,
which arrives with piece 8.
