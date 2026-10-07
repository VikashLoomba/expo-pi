> **Superseded by the pi-agent Cleanup Plan (https://claude.ai/code/artifact/a114f99b-474c-48bc-97ab-69b9a7bd2c66). Do not implement from this file.** It describes the pre-cleanup design and will be rewritten or deleted as the cleanup lands.

# Expo adapter for Pi's modern OpenAI OAuth provider

This module implements Pi's public `OAuthAuth` contract for **`openai` / Sign in with ChatGPT** using Expo SDK 58. It retains the SDK provider's model catalog, API-key authentication, and Responses API transport. Pi's `Models` persists credentials and coordinates refresh; `pi-durable` consumes that same `Models` instance.

On iOS, the [Swift callback module](../../../modules/pi-oauth-callback/README.md) receives the SDK's HTTP loopback redirect through Apple Network. The Expo authentication browser closes when the callback arrives. Platforms or builds without the module, unavailable ports, and browser failures retain the same-request manual fallback.

**Modern device-code authorization is not available through Pi's SDK.** The installed `pi-ai` 1.0.4 (checked October 7, 2026), and earlier 1.0.0, 1.0.1 and upstream revision `83692682f095528f8b71652ddacff7075e36e893`, inspected on October 3, 2026, implement browser authorization code + PKCE with a manual full-callback-URL fallback. `LoginOptions.getDeviceId` supplies an installation UUID, not a device-code grant. The shared `device_code` event type does not add that capability to this provider. The SDK's device-code implementation belongs to its legacy **`openai-codex`** provider, which this app does not register. [Modern login implementation](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/auth/oauth/openai-chatgpt.ts#L233), [login options](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/auth/types.ts#L202), [legacy device flow](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/auth/oauth/openai-codex.ts#L341).

## Public SDK integration

[`../models.ts`](../models.ts) registers `openaiProvider()` and replaces only `provider.auth.oauth` with `createNativeOpenAIOAuth()`. The desktop SDK flow imports Node HTTP/crypto modules; the app uses the supported provider extension interface rather than importing or patching those internals. [SDK provider](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/providers/openai.ts), [public `OAuthAuth` contract](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/auth/types.ts).

The app's runtime calls `models.login('openai', 'oauth', interaction, options)` with options from `getOpenAILoginOptions()`. The installation UUID is durably saved before login and remains separate from the account credential. `interaction.notify()` drives status; `interaction.prompt()` bridges Pi's awaited prompts to the React UI. The runtime serializes credential changes against model work.

| File | Responsibility |
| --- | --- |
| `index.ts` | Expo PKCE login, manual fallback, refresh and `toAuth`; external-browser action. |
| `browser.ts` | Starts the native receiver before browser presentation; arbitrates callback, browser dismissal, cancellation, and cleanup. |
| `core.ts` | Modern protocol constants, strict callback/token validation and safe errors. |
| `installation.ts` | Persistent installation UUID supplied through `LoginOptions.getDeviceId`. |
| `../provider-credentials.ts` | Provider-keyed credential storage and serialized mutation, including secure persistence after token rotation. |

## Browser and manual callback lifecycle

Expo `AuthRequest` creates the PKCE verifier/challenge and authorization request. The modern protocol uses dynamic client registration, an installation host ID, and ChatGPT direct-use scope; authorization returns the **issued client ID**, which is used for token exchange and refresh.

The adapter retains Pi's `http://127.0.0.1:1455/auth/callback` redirect. It waits for the Swift listener to bind that exact loopback endpoint before attempting Expo native authentication presentation. The receiver buffers a callback until JavaScript waits for it, then the coordinator closes and drains the browser session before releasing the login lock. Cancellation closes the receiver and never exchanges tokens. If that presentation throws, is dismissed, or returns no callback, the app requests Pi's `manual_code` input containing the **entire final callback URL**. **Open in browser** opens the original authorization URL in the external browser through `expo-linking`. The original Expo request, state, and verifier remain active. This fallback uses the same authorization-code grant with manual return.

Both callback paths require the exact origin/path, matching state, one nonempty authorization code, and one issued client ID. Duplicate parameters, OAuth errors, unexpected fragments, and credentials embedded in the URL are rejected before exchanging tokens. **Cancel sign-in** aborts the attempt and pending prompt. The external browser remains under the user's control; the app cannot dismiss it.

The native receiver uses an Apple-only local Expo module with `@ExpoModule` and `@JS` Swift macros. It validates method, Host, path, and OAuth state before accepting a callback. The existing TypeScript validator still checks the complete returned authorization. Requests have bounded size, connection count, and lifetime. The browser response is static and never reflects authorization data. Session IDs protect subsequent logins from stale cleanup; Expo module destruction also stops outstanding work. Expo's documented custom-scheme or universal-link capture is not required for this HTTP callback. Native presentation, full-URL manual entry, live authenticated consent, and authenticated inference are separate verification gates. [Expo 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo 58 Linking](https://docs.expo.dev/versions/v58.0.0/sdk/linking/).

## Credential separation and validation

Modern OAuth stores access/refresh tokens, expiry, issued `clientId`, and granted `scopes` under provider `openai`. An API key and ChatGPT OAuth are alternative credentials for that provider. Existing chats keep their saved provider/model settings.

Credentials use Expo SecureStore through the app's single `ProviderCredentialStore`. Tokens remain outside conversation SQLite records. Pi performs refresh under `CredentialStore.modify` with its own timeout signal and never forwards caller cancellation into that call, so a fully received rotating token is saved even if its waiting caller cancels. The adapter rejects modern credentials missing the issued client ID or direct-use scope and avoids exposing raw token endpoint error bodies. As in the inspected Pi implementation, ID-token claims are not used as verified account identity or displayed profile data.

[`tests/openai-pi-auth.test.mjs`](../../../tests/openai-pi-auth.test.mjs) exercises real Pi `Models` and Expo request/PKCE builders with synthetic HTTP responses and substituted native I/O. It covers provider isolation, persistence, automatic and manual callback handling, rejection, cancellation, refresh, and the SDK Responses transport. These tests do not prove live authenticated consent or automatic native callback acceptance. Native verification runs on the simulator; physical-device use is installation only.
