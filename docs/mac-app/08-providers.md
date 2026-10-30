# Piece 8: Providers

## Goal

The Mac signs in to its own providers for its chats: ChatGPT through the browser, API keys for every provider, sign
out; the Providers pane in Settings and the Connect prompts lead there.

## What upstream does

- The server's `ServerSignIn` (`apps/mobile/server/sign-in.ts:25`): one attempt at a time, prompts kept as state in
  the contract's `SignInAttempt` shape, `signIn`, `answer`, `cancel`, `setApiKey`, `signOut`, `getSnapshot`;
  `openAILoginOptions(backend)` (`server/credentials.ts:16`) keeps the installation ID. pi-ai's Bun sign-in flows
  (`registerBunOAuthFlows`, as pi's own binary registers them) run the OAuth dance; on a machine the browser is
  elsewhere, so the flow asks `manual_code`; on the Mac the browser is local, so the attempt's `url` opens here and
  the Mac's receiver from piece 6 answers the prompt. Whether pi-ai's Bun flow already listens on `1455` itself is
  checked in the installed pi-ai first; then the relay only opens the URL.
- The phone's `useProviderSignIn` (`chat-provider.tsx:285-380`), `saveProviderKey` (`:420-430`),
  `disconnectProvider` (`:432-444`), `refreshCatalog` (`:409-415`); `account.tsx` (84) and `provider-section.tsx` (146).
  The providers are `chat-providers.ts:15-16`; `STORED_CREDENTIALS_ONLY` applies on every runtime.

## Builds

- Deviation 2, done with piece 2 so the server bundle settled early: `ServerSignIn` is
  `packages/infinichat/src/node/sign-in.ts` and `openAILoginOptions` joined `node/credentials.ts`; the server imports
  them from there.
- `src/main/account.ts` gains `ServerSignIn(models, credentials, openAILoginOptions(backend))` and the relay from
  piece 6 reused for the Mac's own attempts.
- `src/contract.ts`: `MacAccount` (input `{}`): cells `catalog`, `access`, `signInAttempt`; methods `signIn`,
  `answer`, `cancelSignIn`, `setApiKey`, `signOut`, `refreshCatalog`. The same shapes as `MacInfiniChat`'s account
  cells, so `providers.tsx` serves both.
- `src/view/settings.tsx` gains the Providers pane; the sidebar footer's account button and the Connect cards and
  notices of pieces 3, 6 and 7 open it, with the provider preselected (`account.tsx?provider=`).

## Ownership and lifetime

Credentials live in `userData/credentials.json` (mode 0600) for the app's lifetime of installs; the attempt ends with
success, failure, cancel, another attempt or quit, never with a closed window.

## Deviations

2.

## Size

About 300 lines: account and relay reuse 60, contract and serve 60, pane and wiring 180.

## Checks

- Sign in to ChatGPT on the Mac: the browser opens, the callback completes the attempt without pasting; a chat sends
  with it. Save an Anthropic API key; disconnect; the chat's Connect notice appears and leads here.
- The installation ID is stable across relaunches; a locked or unreadable credentials file reports in `access`.

## As built (2026-10-29)

- **The account's sign-in is the package's `ServerSignIn`**, as the server runs it for a machine
  (`infinichat-server/src/main.ts:64`), over the app's `fileCredentialBackend` with `openAILoginOptions` for the
  installation ID. `src/main/account.ts` registers pi-ai's Bun OAuth flows at startup for the same reason the
  server does: Hutch's single-file main process cannot resolve the import pi-ai loads them through. `close()` ends
  an attempt at quit, after the host has closed the windows' links.
- **The relay only opens the browser for this Mac's own attempt.** pi-ai's ChatGPT flow listens on `127.0.0.1:1455`
  itself and races the callback against its `manual_code` prompt (pi-ai 1.4.0 `auth/oauth/openai-chatgpt.js`,
  `startCallbackServer`, `loginOpenAIChatGPT`), so a second receiver would only take its port. `SignInRelay` now
  takes a `SignInSource` (`subscribe`, `getSignIn`) and an optional `answer`: with one, as for the holder machine's
  attempt, it listens and hands the callback to the prompt; without one, as for this Mac's, the URL opens and the
  flow completes on its own. A ChatGPT sign-in here and one on the holder at the same time contend for the port;
  pi-ai reports it ("Port 1455 is in use…") and the attempt is retried.
- **`MacAccount` grew its sign-in**: the `signInAttempt` cell and `signIn`, `answer`, `cancelSignIn`, `setApiKey`
  and `signOut`, the same shapes as `MacInfiniChat`'s, so `ProviderSections` from piece 6 serves both without
  change (`ProviderAccount` is satisfied by either reference).
- **The Providers pane** is `src/view/components/settings/providers.tsx`: the sections and the phone's privacy note
  rewritten for this Mac. The Settings window (`screens/settings.tsx`) switches panes from its sidebar, holds the
  account and the app (for the sign-in rows' Open in browser), and reads which pane to show from a `SettingsTargets`
  store (`view/lib/commands.ts`). An attempt is the app's, so leaving the pane or closing the window ends nothing,
  as the plan's lifetime says; the phone's screen cancels on leaving, the holder's sheet too.
- **Where a notice leads**: `MacApp.openSettings` takes an optional `SettingsTarget` (`{ pane, provider? }`, the
  phone's `account.tsx?provider=`). A new Settings window gets it in its preload bootstrap beside the port and
  secret, an open one as the `show` message of the window RPC (`rpc.ts`), since Electrobun's `views://` pages are
  the app's own and the bootstrap already is the way in. The chat screen's two Connect notices, the chat settings
  sheet's and the sidebar's Connect card open the Providers pane with the chat's provider first; the InfiniChat
  screen's Add Machine… and Manage Machines… open Machines; the menu's Settings… opens the window where it was.
- **One copy of pi-ai in the bundle.** The first build failed its first ChatGPT sign-in with "Cannot find module
  './openai-chatgpt.js'": the main process bundle held two copies of pi-ai, one resolved by `apps/mac` and one by
  `packages/infinichat`, because pnpm had resolved their `@anthropic-ai/sdk` zod peer differently (zod 3 for the
  app, zod 4 for the package; `pnpm why -r @earendil-works/pi-ai` said "2 variations"). The app's registration
  reached its own copy's loader, and the package's `createModels` used the other's. `pnpm dedupe` collapsed the
  lockfile onto the package's variant (pi-ai, pi-durable and pi-env alike, and the lint plugin's zod to 4; two
  patch bumps of browserslist and the phone's babel-preset-expo came with it); the bundle now has one loader. Two
  copies would also have broken every `instanceof` on pi-ai's errors between the app and the package.
- Not built: a sidebar footer account button (the footer shows the version; the Connect card and the notices are
  the ways in, as on the phone), and "Refresh models" on the pane (the chat settings sheet has it, as the phone's
  does).

Size: about 190 lines changed or added against the plan's ~300, since piece 6's relay and provider list and
piece 7's account already covered most of it.
