# Piece 6: InfiniChat settings, providers and tasks

## Goal

Everything the phone's InfiniChat sheets do: the settings sheet, the holder machine's providers with sign-in, the
scheduled tasks sheet, and notifications at task time.

## What upstream does

- **Settings:** `infinichat-settings/_layout.tsx` builds the draft, `index.tsx` (199) saves `updateSettings` and the
  avatar (`:102-128`); `settings-controls.tsx` (156) has the model section, choices and search; `settings-drafts.tsx`
  (77) holds the draft. The avatar is phone-local (`infinichat-avatar.ts`). The catalog, access and sign-in come from
  the machine (`useInfiniChatAccount`, `chat-provider.tsx:570-696`): `setApiKey`, `signIn`/`answer`/`cancelSignIn`/
  `signOut` on the remote object; for ChatGPT the attempt's `url` opens in the phone's browser and its loopback receiver
  on `127.0.0.1:1455` answers the machine's `manual_code` prompt with the redirect (`:600-635`;
  `modules/pi-oauth-callback`). `provider-section.tsx` (146) is the provider list UI.
- **Scheduled tasks:** `infinichat-schedule/index.tsx` and `edit.tsx` over `InfiniChatHost.scheduled` and
  `cancelScheduled(id, replacement)`; `ScheduledTaskNotifications` (`infinichat-notifications.ts:39`) mirrors the
  store into one notification per waiting task, replaced on change (`follow`, `:50`).
- **Electrobun:** `Utils.showNotification({ title, body })` (immediate only, no tap event); `Utils.openFileDialog`
  for the avatar; `appdata://` serves files under `userData` to a window with `allowedProtocols.appData`.

## Builds

- `src/contract.ts`: `MacInfiniChat` gains `updateSettings`, `cancelScheduled`, `setAvatar` (from a chosen file;
  returns the `appdata://` path), `clearAvatar`, a cell `avatar`, cells `catalog`, `access`, `signInAttempt` and the
  account methods forwarded to the shown client (`signIn`, `answer`, `cancelSignIn`, `setApiKey`, `signOut`).
- `src/main/avatar.ts`: the file copied to `userData/avatar/<uuid>.<ext>`, its name in `settings.json`.
- `src/main/sign-in-relay.ts`: when the shown attempt has a `url`, `Utils.openExternal` opens it once; a loopback
  receiver on `127.0.0.1:1455` (`node:http`, bound while an attempt runs) answers the pending `manual_code` prompt with
  the URL it receives, as the phone's native receiver does.
- `src/main/notifications.ts`: follows the shown client's `scheduled` store: one timer per waiting task until its time
  (clamped to `setTimeout`'s limit and re-armed), `Utils.showNotification` with the task's text; timers replaced when
  the list changes, cleared at quit.
- `src/view/infinichat-settings.tsx` (a `<dialog>` sheet: Name, Avatar with Choose… and Remove, Main and Summary
  model sections with provider, model search and effort, Instructions, Refresh models, Connect notices opening the
  providers sheet, Cancel and Save), `providers.tsx` (the provider list shared with piece 8: Sign in, API key,
  Disconnect, the attempt's prompts and status), `scheduled.tsx` (the list soonest first, edit text and time, Delete).
  A sheet with changes asks before closing, as the phone's form sheets do.

## Ownership and lifetime

The relay's receiver listens only during an attempt and closes with it. Timers belong to the notifier, which the
composition closes at quit.

## Deviations

None beyond the platform differences in the README (no tap actions; file avatar).

## Size

About 500 lines: contract and serve 70, avatar, relay and notifier 130, sheets 300.

## Checks

- Change the name, instructions and models on the Mac; the phone shows them; the avatar shows on the Mac only.
- Sign in to ChatGPT on the holder machine from the Mac: the browser opens, the callback lands on the Mac, the machine
  signs in; an API key saves; sign out works; cancel mid-attempt.
- A task scheduled by the agent appears in the sheet and fires a Mac notification at its minute while the app runs;
  editing its time re-arms it; deleting removes it on the machine and the phone's list.

## As built

From `4bd7ba8` (2026-10-29), one commit, with Electrobun 2.0.5 (Hutch 0.28.2), chord 1.4.0, pi 1.4.0, shadcn 4.23
(style `base-nova`) and Base UI 1.9. What differs from the plan:

- **The sheets are shadcn dialogs, not `<dialog>` elements.** `components/infinichat/form-sheet.tsx` is one
  `FormSheet` over Dialog with the owner's form-sheet rules: Cancel leads and Save trails, Enter saves, and closing a
  sheet with unsaved changes by Escape, a click outside or Cancel asks in an AlertDialog ("Discard changes?") first.
  `settings-sheet.tsx`, `providers-sheet.tsx` and `scheduled-sheet.tsx` build on it; `useSheet` keys each sheet by
  its opening, so it mounts with the values of that moment and keeps them until Save or Cancel, as the phone's draft
  provider does. The files live under `src/view/components/` with the other screens' parts, not at `src/view/`.
- **The model choice is a Combobox** (`combobox`, added with the CLI) in `components/chat/model-section.tsx`, the
  phone's `ModelSection` for piece 7's chat settings too: provider and effort are Selects, the model a combobox
  searched by name and ID, in place of the phone's pushed list with its search bar.
- **The avatar applies as it is chosen**, not at Save: `setAvatar` opens the file dialog, copies the file to
  `userData/avatar/<uuid>.<ext>`, names it in `settings.json` and returns its `appdata://avatar/<file>` URL;
  `clearAvatar` removes it; the main window allows `appData`. The phone keeps the avatar in its draft because Image
  Playground hands it a temporary file; a chosen file is already the user's own. `.agent-mark img` fits it to the
  mark, which the chatbot rework had left without image rules.
- **No Refresh models.** The machine's catalog is a fixed cell of its server (`serve.ts:26`); the phone's button
  refreshes the phone's own registry, which InfiniChat on a machine never reads.
- **Sign-in is offered for ChatGPT only**, as the phone's registry offers it (`providerOAuth`): the catalog carries no
  auth information, so `providers/provider-sections.tsx` knows ChatGPT's name and label itself; the other providers
  take API keys. `ProviderSections` reads a `ProviderAccount` (the contract's account cells and methods), which piece
  8's `MacAccount` satisfies as well.
- **The relay follows the attempt as state**, not as the phone's promise chain: `SignInRelay` subscribes to the
  composition, opens an attempt's URL once in the default browser, binds the receiver on `127.0.0.1:1455` when that
  URL is ChatGPT's authorization URL (it carries the state the callback must return with), checks the callback with
  the package's `validateOpenAICallback`, answers the `manual_code` prompt once it shows, and closes the receiver with
  the attempt. A refused callback or an occupied port is logged and leaves the prompt to the sheet's paste field and
  its Open in browser. A closed window changes nothing.
- **The notifier follows `ShownInfiniChat.scheduled`**, subscribed at launch so the shown side's list is followed
  whether or not a window holds it; a timer due the moment its task starts still fires.
- **The screen** gained what the phone's has around these sheets: the header title opens the settings sheet, a
  clock button the scheduled tasks, the Connect notice ("Connect <provider> on <machine> to send a message", with
  Providers) and the saved-settings error with Settings; sending waits for the main model's provider to be
  connected, as on the phone. No "Restoring your connection…" while the holder connects: the subtitle says so.

Size: about 1,150 lines (contract and serve 60, the composition 30, avatar, relay and notifier 240, the sheets, the
model section and the provider list 750, the screen 70), twice the plan's 500. The phone's own equivalents
(`infinichat-settings/*`, `settings-controls.tsx`, `settings-drafts.tsx`, `provider-section.tsx`, `auth-prompt.tsx`,
`infinichat-providers.tsx`, `infinichat-schedule/*`, `infinichat-notifications.ts`, `infinichat-avatar.ts`,
`openai-auth/browser.ts`, the native receiver and the account flow in `chat-provider.tsx`) are about 1,700.

Verified on this Mac (2026-10-29): typecheck, lint and the dev build; the app starts with the relay and the notifier
composed, serves the new cells and opens its window without an error of its own. Not verified, since this session
cannot see or drive the window: the sheets themselves, the avatar through `appdata://`, saving settings and the phone
showing them, a ChatGPT sign-in through the relay (it needs the owner's account), an API key, sign out, a task's
notification at its minute (Notification Center may refuse an unsigned dev build), and editing or deleting a task on
the machine. The window's console reports a duplicate React key (`0`) from the transcript at startup, which predates
this piece.
