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

## Ownership and lifetime

| Resource | Created by | Cancelled by | Closed by |
| --- | --- | --- | --- |
| Credential store and file | `server/main.ts` | — | lives as long as the process; the file persists |
| A sign-in attempt | `signIn` on the server object | `cancelSignIn`, a new attempt, server close | the server object |
| The phone's receiver session | the phone, while it shows the URL | the phone (dismiss or cancel) | the phone, as `browser.ts` does today |

## Deviations (need approval)

- **None from pi:** a host-injected store and the interaction relay are what pi-ai documents.
- **The file backend is new host code.** pi-ai ships only the in-memory store, and its CLI's `auth.json` writer
  (`src/cli.ts`) isn't exported.
- **pi-ai's default environment lookup on the server.** The phone disables it because "Mobile apps have no process
  environment" (`src/pi/models.ts`). Keeping pi-ai's default on Node follows upstream; say so if a key from the
  machine's environment should not count.

## Size

About 220 lines: file backend ~40, sign-in object and state ~100, phone relay and the screens' catalog source ~80.

## Checks

On the owner's iPhone Release install, InfiniChat database backed up:

- Sign in to ChatGPT on a machine from the phone, then send a message: the machine answers.
- Restart the server: still signed in.
- Lock the phone overnight with the conversation on the machine: the server's refreshes happen there, and the
  phone's own account stays signed in.
- Add an API key for another provider from the phone; sign out of it.
- Cancel a sign-in halfway: nothing is stored.

## Not in this piece

Moving the conversation (piece 5).
