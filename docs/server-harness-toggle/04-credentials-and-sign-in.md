# Piece 4: Credentials and sign-in

## Goal

The server has its own model credentials, and you sign in to them from the phone. InfiniChat's settings show the
server's providers and models while InfiniChat runs on a machine.

## The idiomatic pi way

- **pi-durable has no credentials of its own.** The Harness uses whatever pi-ai `Models` its host passes in:
  `HarnessOptions.models`, "a `Models`… or a function returning the current one" (`src/harness/types.ts:616` at
  v1.4.0).
- **pi-ai keeps credentials in a store the host injects.** "pi-ai ships an in-memory default; apps inject persistent
  storage" (`README.md:456`, "Credential Store"). Refresh runs inside the store's `modify`, so concurrent requests
  "cannot double-refresh a rotated token" within one store. Sign-in is `models.login(provider, type, interaction)`,
  where the interaction's `prompt` and `notify` reach the user wherever they are (`README.md:1785`, "OAuth
  Providers").
- **pi-env puts the credentials with the Durable worker.** Its README describes tools running on another machine
  "while the Durable worker, its storage and credentials stay local" (`README.md:4`).

So the machine that runs the Harness owns a persistent `CredentialStore`, and the phone is the interaction's front
end. Copying the phone's credentials is not the pi way: two stores refreshing one rotating OAuth token can log one
side out.

## Starts from

- The app's `ProviderCredentialStore` (`src/pi/provider-credentials.ts`), a pi-ai `CredentialStore` over a
  three-method `CredentialBackend` (`src/pi/secure-storage.ts:4-8`). Its only phone dependency is that interface's
  type import, so the server reuses it as is, with the same OpenAI policies as `createChatCredentialStore`.
- The account screen's sign-in (`useProviderSignIn` in `src/chat/chat-provider.tsx`):
  - one attempt at a time;
  - `models.login(…, { prompt, notify }, options)`;
  - prompts through `AuthPromptController`;
  - API keys saved with `credentials.modify(providerId, async () => ({ type: "api_key", key }))`
    (`chat-provider.tsx:291-295`).
- The ChatGPT browser flow (`src/pi/openai-auth/browser.ts`, `README.md`): the native receiver on
  `http://127.0.0.1:1455/auth/callback` (`core.ts:7`), with pi's `manual_code` as the fallback. pi-ai notes that
  "manual_code prompts race a local callback server" (`README.md:1808`).

## Builds

### Server

- **`server/credentials.ts`:** a file `CredentialBackend` for `ProviderCredentialStore`, in
  `~/.infinichat/credentials.json`, mode `0600`, written to a temporary file and renamed. `server/models.ts`
  (piece 1) passes the store to `createModels({ credentials })`. Auth resolution keeps pi-ai's Node defaults, so a
  provider key in the service's environment counts too. launchd and systemd user services start with a minimal
  environment, so usually there is none.
- **Contract additions:**
  - **State:**
    - `catalog`: `buildModelCatalog(models)` from the server's `Models`.
    - `access`: per provider `{ connected, expired, error? }`, as the account screen's `ProviderAccess` shows it.
    - `signIn`: the current attempt: provider, a public status line, and the pending prompt. A prompt is
      `{ id, type, message, placeholder?, options? }`, mirroring pi-ai's `AuthPrompt`. An `auth_url` event carries
      the URL to open.
  - **Methods:**
    - `signIn({ providerId })`
    - `answer({ promptId, value })`
    - `cancelSignIn()`
    - `setApiKey({ providerId, key })`, the account screen's `modify` path
    - `signOut({ providerId })`
- **Sign-in on the server:** one attempt at a time, as on the account screen. `prompt` resolves when `answer`
  arrives with its id; `notify` updates `signIn`. The state lives in a cell, so a phone that reconnects mid-attempt
  sees the pending prompt again. The attempt ends when it succeeds, when the phone cancels, when another attempt
  starts, or when the server closes. A dropped link alone does not end it.

As built (pi 1.4.0, tag `4a080252f`; Chord 1.4.0; Expo 58.0.17, expo-auth-session 58.0.14):
- **`server/credentials.ts`:** `fileCredentialBackend(file)`, one JSON object of the store's items.
  - Each write reads the file, changes one item, writes `credentials.json.<pid>` with mode `0600` and renames it into
    place. Writes run one at a time, so two providers' writes never drop each other's. The store orders each
    provider's own operations.
  - `main.ts` builds `new ProviderCredentialStore(backend, { openai: { validate: validateOpenAICredential } })`,
    registers the providers and restores them before it serves, as the phone does.
- **The OpenAI installation ID.** pi-ai's Node ChatGPT sign-in requires `LoginOptions.getDeviceId`, a UUID that must
  be the same on every login, and fails without one (`src/auth/oauth/openai-chatgpt.ts:225-231`). pi-ai's own CLI
  makes a new one each time and says "apps should reuse one across logins" (`src/cli.ts:51`, `:73`).
  - `openAILoginOptions(backend)` keeps the machine's own ID in the same file, under the phone's key
    `pi.openai.host.v1`, made at the first ChatGPT sign-in, as `src/pi/openai-auth/installation.ts` does on the phone.
  - It also passes `agentName: 'InfiniChat'`, the name the phone's own sign-in gives OpenAI (`agent_name_hint`).
- **The sign-in flows are registered statically.** pi-ai loads each OAuth flow with an `import()` of a variable
  specifier "so bundlers cannot follow the import" (`src/auth/oauth/load.ts:4-13`). The single-file server bundle then
  has no `openai-chatgpt.js` to load: measured, `models.login` rejected with `ERR_MODULE_NOT_FOUND`.
  - `createServerModels` calls `registerBunOAuthFlows()` from pi-ai's public `./bun-oauth` export
    (`src/bun-oauth.ts:13`), as pi's own standalone binary does at startup (coding-agent `src/bun/runtime-setup.ts:10`).
    The name says Bun, but the module only imports the flows statically, and they use only `node:http` and
    `node:crypto`.
  - The asset grew from 8,109,307 to 8,246,243 bytes.
- **The contract** (`src/pi/infinichat-remote/contract.ts`):
  - **The state member is `signInAttempt`, not `signIn`.** `signIn` is the method that starts one, and Chord refuses a
    member that is both state and method (`src/contract.ts:237`).
  - **`access` is the store's own `ProviderAccess` per provider**: `{ ready, connected, type?, error?, retryable? }`.
    An expired session is its `error`, `SESSION_EXPIRED`, as on the account screen. `ProviderAccess` and the
    catalog's `ModelOption`, `ProviderOption` and `ImageInput` became `Static<…>` of TypeBox schemas beside the types
    they replace, as piece 1 did.
  - **`signIn` returns the attempt's number**, so the phone knows which attempt is its own.
  - **An attempt that ended stays in `signInAttempt`** with `running: false`, until the next one starts:
    - with the account screen's "Sign-in cancelled." or "Sign-in could not be completed. Please try again.";
    - with no `status` after a sign-in that succeeded, as the account screen clears its notice then.

    A call's result can reach the phone before the state that shows its attempt, so a value that went back to `null`
    would leave the phone unable to tell a finished attempt from one it hasn't seen yet. `null` means no attempt since
    the server started.
  - `answer` returns nothing. An answer to another prompt, or an empty one, changes nothing
    (`AuthPromptController.submit`).
- **`server/sign-in.ts`: `ServerSignIn`**, the account screen's `useProviderSignIn` with its interaction kept as
  state.
  - It uses the app's own `AuthPromptController` (`src/chat/auth-prompt-controller.ts`, host-neutral) for the pending
    prompt, the same copy for the status line, and the same `modify` checks for API keys.
  - `signIn` only starts the attempt and returns. Chord's guide says a long wait is state and its answer a separate
    call (`docs/guide.md:503-518`).
  - The prompt crosses without its `AbortSignal`, and with no field set to `undefined`.
  - `main.ts` owns it, and cancels an attempt under way at shutdown, after the host has closed the links.
- **The catalog cell is set once.** None of the six registered providers has `refreshModels`, so pi-ai's
  `models.refresh()` changes nothing for them.
- **No `isPermanentAuthError` policy on the server.** The phone's `isPermanentOpenAIAuthError` matches its own native
  adapter's `OpenAITokenRequestError`. pi-ai's Node refresh throws a plain `Error` ("OpenAI OAuth token request failed
  (400): …", `openai-chatgpt.ts:146`), so that policy would never match there. A refused refresh on the machine
  surfaces as pi-ai's `ModelsError` `oauth`, and signing in again replaces the credential.

### Phone

- In remote mode, InfiniChat settings and the model screen read the server's `catalog` and `access` instead of
  `useChatApp().catalog`. Each provider shows "Sign in on <machine>".
- Prompts render with the account screen's components (`AuthPromptController`, `components/chat/auth-prompt.tsx`),
  fed by the server's `signIn` state; answers go back through `answer`.
- **ChatGPT:**
  1. The phone opens the server's authorization URL with the existing native receiver and browser flow.
  2. The redirect lands on the phone's own `127.0.0.1:1455`, the same redirect pi-ai uses.
  3. The phone answers the server's `manual_code` prompt with the whole callback URL, which pi-ai accepts in place
     of its own local callback.

  The one change: `browser.ts` starts the receiver with the app's own `request.state`, so it needs a form that takes
  the state of a URL the phone didn't build.
- The phone's own account (ordinary chats) is never touched.

As built:
- **`useInfiniChatAccount()`** (`src/chat/chat-provider.tsx`) is what InfiniChat's screens read:
  - on the phone, this iPhone's account, unchanged;
  - while a machine is chosen, the machine's `catalog` and `access`, with the account screen's operations on the
    machine's store.

  Used by:
  - the InfiniChat tab, which gates sending on the provider's access, so it now follows the machine's;
  - InfiniChat settings and its model screen;
  - the new providers screen.
- **The providers screen.** `src/app/infinichat-providers.tsx` is a modal titled "Providers on <machine>". The account
  screen's `ProviderSection` moved, unchanged, to `src/components/chat/provider-section.tsx`, and takes the account it
  shows as a `ProviderAccount`. The account screen passes `useChatApp()`, and the machine's screen passes
  `useInfiniChatAccount()`.
  - The settings notice reads "Sign in to <provider> on <machine> before InfiniChat can use it", with "Sign in on
    <machine>". The tab's composer reads "Connect <provider> on <machine> to send a message". Both open the machine's
    screen.
  - "Retry connection" shows only where there is a `retryAuth`, so not on the machine's screen.
- **Which sign-ins it offers** is what this phone can present: `providerOAuth` from the phone's own `Models`.
  - That is ChatGPT, through the receiver, and API keys for every provider.
  - pi-ai's Node flows for Anthropic, OpenRouter and xAI exist on the machine, and its `signIn` would start them. The
    phone shows no button for them, as its account screen shows none.
- **ChatGPT.** `openOpenAIBrowserFor(url, signal)` (`src/pi/openai-auth/index.ts`) leaves `browser.ts` unchanged. It
  builds Expo's `AuthRequest` with the server URL's `state` and the shared redirect. `promptAsync({ url })` uses only
  that `redirectUri` and that `state` (expo-auth-session `src/AuthRequest.ts:137-201`). The receiver takes any
  non-empty state of up to 1,024 bytes without control characters (`OAuthCallbackServer.swift:54-55`), pi-ai's
  base64url included.
  - The callback is checked with `validateOpenAICallback`, as the phone's own sign-in checks it, before it answers.
  - The hook waits for the attempt's URL, opens the browser, then answers the attempt's `manual_code` prompt with the
    callback (`RemoteInfiniChat.signInStep`).
  - The browser is dismissed when the machine's attempt ends, however it ends.
  - Without a callback, the machine's prompt stays on screen for a pasted URL, with "Open in browser"
    (`openOpenAIManualBrowser`, now sharing the URL check).
  - pi-ai's prompt is open from the start, because it races pi-ai's own callback server
    (`openai-chatgpt.ts:271-282`). So the paste field shows behind the browser, where the phone's own sign-in shows
    it only after the browser.
- **Leaving the providers screen cancels the attempt**, as leaving the account screen does. Only an attempt under way
  is cancelled, so leaving while disconnected starts no connection. A dropped link or a killed app doesn't cancel it.
- **The settings screen's "Refresh models"** still refreshes the phone's catalog. The machine's never changes (above),
  and neither does the phone's for these providers.

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| Credential store and file | `server/main.ts` | — | lives as long as the process; the file persists |
| A sign-in attempt | `signIn` on the server object | `cancelSignIn`, a new attempt, server close | the server object |
| The phone's receiver session | the phone, while it shows the URL | the phone (dismiss or cancel) | the phone, as `browser.ts` does today |
| `ServerSignIn` and its attempt (as built) | `server/main.ts` | `cancelSignIn`, a new attempt, `signOut`, shutdown | `main`, after the host |
| pi-ai's callback server on the machine's 1455 (as built) | pi-ai, per ChatGPT attempt | the attempt's signal | pi-ai, when the attempt ends (`openai-chatgpt.ts:288-297`) |
| The machine's OpenAI installation ID (as built) | the first ChatGPT sign-in | — | never; it stays in `credentials.json` |
| The phone's part of an attempt: its browser and the waits for the URL and prompt (as built) | the providers screen's `signIn` | Cancel, leaving the screen, the attempt ending on the machine | the hook |

## Deviations (need approval)

- **None from pi:** a host-injected store and the interaction relay are what pi-ai documents.
- **The file backend is new host code.** pi-ai ships only the in-memory store, and its CLI's `auth.json` writer
  (`src/cli.ts`) isn't exported.
- **pi-ai's default environment lookup on the server.** The phone disables it because "Mobile apps have no process
  environment" (`src/pi/models.ts`). Keeping pi-ai's default on Node follows upstream; say so if a key from the
  machine's environment should not count.

Found while implementing, against the installed 1.4.0 sources:

- **`registerBunOAuthFlows()` in the server bundle.** pi-ai's own seam for single-file binaries, as its standalone
  binary uses it. Without it no OAuth sign-in runs on the server (above).
- **The machine's own OpenAI installation ID** in `credentials.json`. pi-ai requires one for ChatGPT, and says apps
  keep it (above).
- **`signInAttempt`** as the state member's name, an attempt's number from `signIn`, and an ended attempt kept until
  the next (above).
- **A busy port 1455 on the machine fails ChatGPT sign-in.** pi-ai 1.4.0 starts its callback server first and throws
  "Port 1455 is in use, probably by an unfinished login in another pi session or by the Codex CLI" before any URL or
  prompt (`openai-chatgpt.ts:243-248`). It has no manual-only path, though the browser's redirect never reaches that
  port here. Measured: the attempt ends with the account screen's "Sign-in could not be completed. Please try again."
  The machine's real message is not shown, because the account screen's rule is to never render pi-ai's error text.
- **The machine's `access` counts stored credentials only.** That is what `ProviderCredentialStore` reports, and
  sending is gated on it, as on the phone. So a key in the service's environment, which pi-ai would use, still shows
  "Not connected" and blocks the composer. launchd and systemd user services usually have none (above).
- **The store's messages are the phone's.** A credential file the store cannot read says "Could not restore your
  saved provider credentials. Unlock this device and try again.", because `ProviderCredentialStore` is reused
  unchanged.
- **`openai-auth/core.ts` reads an error body as `unknown`.** The server's typecheck now covers the file. Node's types
  give `response.json()` `unknown`, where the DOM lib gives it `any`, so the `invalid_grant` check reads it through
  `isRecord`, with the same behaviour.

## Size

About 220 lines: file backend ~40, sign-in object and state ~100, phone relay and the screens' catalog source ~80.

As built, +816 −205 lines outside the asset and its manifest, about 480 new:
- `server/` about 245: `sign-in.ts` 141, `credentials.ts` 63 with the installation ID, and the rest in `main`,
  `models` and `serve`.
- The contract and the catalog and access schemas about 85.
- `client.ts` +72, of which `signInStep` is 30.
- The account hook +134, the providers screen 41, and the tab and settings +40.
- `provider-section.tsx`, 168 lines, is about 130 lines moved out of `account.tsx`, which lost 135.

A third or more of the new lines are comments. The growth over the estimate comes from:
- the schemas the catalog needed to cross as Chord state;
- the phone's half of the relay: waiting for its own attempt's URL and prompt across a reconnect, and ending its
  browser with the attempt;
- the installation ID.

## Checks

Done in this piece on the implementer's Mac, with no device available and no real sign-in:
- The app's real `RemoteInfiniChat`, contract, Chord, `openOpenAIBrowserFor` and expo-auth-session's `AuthRequest`
  ran on Node against the real server asset, started by hand.
- Throwaway stand-ins (not committed) replaced react-native-ssh, the Keychain, the native receiver, expo-web-browser
  and React Native's `Platform`.
- The server had no provider variables, and its outbound HTTPS went to a closed port, so a token exchange failed
  locally instead of reaching OpenAI.

The results are in [references](references.md#piece-4-on-macos). Everything below is still unverified.

On the owner's iPhone Release install, InfiniChat database backed up:

- Sign in to ChatGPT on a machine from the phone, then send a message: the machine answers.
- Restart the server: still signed in.
- Lock the phone overnight with the conversation on the machine: the server's refreshes happen there, and the
  phone's own account stays signed in.
- Add an API key for another provider from the phone; sign out of it.
- Cancel a sign-in halfway: nothing is stored.
- Added while implementing:
  - **The real receiver and browser with a server URL.** The native receiver catches the callback for pi-ai's state,
    the authentication session closes, and the machine stores the grant.
  - **Paste and "Open in browser"** on the machine's prompt.
  - **The phone's own sign-in afterwards:** still signed in, and its own ChatGPT sign-in still works.
  - **A killed app mid-attempt:** relaunched, the providers screen shows the machine's pending prompt.

## Not in this piece

Moving the conversation (piece 5).
