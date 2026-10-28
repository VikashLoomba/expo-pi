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
