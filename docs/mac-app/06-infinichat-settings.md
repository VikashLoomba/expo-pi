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
