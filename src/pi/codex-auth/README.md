> **Superseded by the pi-agent Cleanup Plan (https://claude.ai/code/artifact/a114f99b-474c-48bc-97ab-69b9a7bd2c66). Do not implement from this file.** It describes the pre-cleanup design and will be rewritten or deleted as the cleanup lands.

# Expo Codex OAuth adapter

This TypeScript module implements Pi's public `OAuthAuth` interface using Expo SDK 58. Inject it into Pi's real `openai-codex` provider; Pi coordinates refresh, request authentication, and logout through the app’s credential-store implementation. Import the folder entry point, `@/pi/codex-auth`, in this app.

The default configuration uses OpenAI's device-code flow with the public client from Pi 0.87.1. A separate configuration supports Expo's authorization-code/PKCE flow when you have an OpenAI-issued public client registered for your mobile redirect and Codex access. Browser presentation currently supports **iOS only**.

## Requirements

- `@earendil-works/pi-ai` **1.0.0**. The adapter was originally implemented against 0.87.1; its OAuth contract and device-code protocol remain compatible with 1.0.0.
- Expo **58.0.2**, `expo-auth-session` **~58.0.7**, `expo-web-browser` **~58.0.4**, `expo-clipboard` **~58.0.3**, `expo-secure-store` **~58.0.2**, and their SDK-compatible dependencies. Use `npx @expo/agent-cli install expo-auth-session expo-web-browser expo-crypto expo-clipboard expo-secure-store` when integrating into an existing Expo project. Rebuild the development client after updating native dependencies.
- The [`@automatalabs/expo-pi`](../../../packages/expo-pi/README.md) Metro wrapper, which makes Pi's desktop-only dynamic imports bundle on native and installs the secure-random bridge. Copying this folder alone does not make Pi's desktop imports compatible with Metro.
- An iOS development build. Use the app's registered scheme for direct OAuth redirects; Expo Go cannot supply that production callback identity.
- For the default flow, enable device-code login in your ChatGPT account's security settings or workspace permissions, as described in [OpenAI's device-code instructions](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

There is no native callback module to link, localhost listener, or callback relay to deploy. The device authorization protocol is adapted from Pi's MIT-licensed implementation; keep the repository's [LICENSE.pi](../../../LICENSE.pi) when reusing it.

## Public API

| Export | Purpose |
| --- | --- |
| `createNativeCodexOAuth(browser?: CodexBrowserConfig): OAuthAuth` | Create the injectable adapter. Omit the argument for device-code login. |
| `CodexBrowserConfig` | `{ clientId: string; redirectUri: string }` for a registered public mobile OAuth client. |
| `openCodexDeviceBrowser(signal: AbortSignal): Promise<void>` | Present the device verification page through Expo `openAuthSessionAsync`. Aborting dismisses the browser. |
| `createCodexCredentialStore()` | Observable secure credential store, with `subscribe`, `getSnapshot`, and `restore` for session restoration and UI state. |
| `createCodexSession(credentials?)` | Create Models, the real Codex provider, and this adapter. Defaults to the secure credential store; accepts an injected Pi `CredentialStore` for testing. |
| `CODEX_PROVIDER_ID` | `openai-codex`. |
| `MODEL_ID` | The app's pinned catalog selection, `gpt-6-sol`; independent of the OAuth protocol. |

`core.ts` and `device-auth.ts` are internal protocol helpers. They remain free of native imports so their validation, timeout, and cancellation behavior can be tested in Node.

## Inject into Pi

```ts
import { createModels } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createCodexCredentialStore, createNativeCodexOAuth } from '@/pi/codex-auth';

const models = createModels({
  credentials: createCodexCredentialStore(),
  authContext: {
    env: async () => undefined,
    fileExists: async () => false,
  },
});
const provider = openaiCodexProvider();
models.setProvider({
  ...provider,
  auth: { ...provider.auth, oauth: createNativeCodexOAuth() },
});
```

Keep this Models instance for the lifetime of the signed-in session and pass it to Pi's durable `Harness`. The provider's catalog and streaming implementation are unchanged. Set `settings.stream.transport` to `'sse'` for native Codex requests:

```ts
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { openExpoSqliteStorage } from '@/pi/storage';

const storage = await openExpoSqliteStorage();
const harness = await Harness.open(storage, {
  models,
  registry: createRegistry(),
  settings: { stream: { transport: 'sse', maxRetries: 0, timeoutMs: 60_000 } },
}, BACKGROUND_CONTEXT);
// Create/configure conversations and submit inputs after sign-in.
// Reuse this harness/storage across conversations; close it during teardown.
```

The app's [chat service](../chat-service.ts) adds its local tool and conversation metadata, and projects committed records for the UI. Its [lifecycle controller](../../chat/chat-runtime.ts) serializes foreground/background and account transitions. The SQLite adapter stores conversation/task state; it does not store the Models credentials.

For this app, `const models = createCodexSession()` provides the same setup. Its optional `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` setting selects the registered-client flow described below.

## Device-code login and browser lifecycle

Call Pi's `models.login`, render the `device_code` notification, and give the user a separate action to open the verification page. They can also enter the code at the displayed URL on another device. Approval is detected by polling; it does not redirect into the app and does not require simulator Bluetooth.

The adapter automatically copies each newly issued user code with Expo `Clipboard.setStringAsync` before emitting `device_code`. It then emits a `progress` notification confirming the copy, or explaining that manual entry is needed if copying fails. Render progress notifications to show that status. Clipboard failure does not stop authorization. Only the user-facing device code is copied; tokens and the PKCE verifier are never copied. This writes to the clipboard once per login attempt and does not read it or clear it afterward.

The following functions use the `models` instance created above:

```ts
import { CODEX_PROVIDER_ID, openCodexDeviceBrowser } from '@/pi/codex-auth';

let activeLogin: AbortController | undefined;

export async function signIn(
  showDeviceCode: (code: string, verificationUri: string) => void,
): Promise<void> {
  if (activeLogin) throw new Error('Sign-in is already pending.');
  const current = new AbortController();
  activeLogin = current;
  try {
    await models.login(CODEX_PROVIDER_ID, 'oauth', {
      signal: current.signal,
      prompt: async () => { throw new Error('Unexpected interactive prompt.'); },
      notify: (event) => {
        // Also render event.message when event.type is 'progress' to show copy status.
        if (event.type === 'device_code') {
          showDeviceCode(event.userCode, event.verificationUri);
        }
      },
    });
    // Pi has stored the credential. The UI can now allow model requests.
  } finally {
    // Also dismiss a device browser on success or failure, not just cancellation.
    current.abort();
    activeLogin = undefined;
  }
}

export async function openSignInPage(): Promise<void> {
  if (activeLogin) await openCodexDeviceBrowser(activeLogin.signal);
}

export function cancelSignIn(): void {
  activeLogin?.abort();
}

export async function signOut(): Promise<void> {
  // Call after active login has settled and active model work is closed.
  await harness.close(BACKGROUND_CONTEXT);
  await models.logout(CODEX_PROVIDER_ID);
  // Reopen storage/harness with scheduling paused to keep history readable.
}
```

The UI must handle rejected promises from `signIn` and `openSignInPage`, clear the displayed code when login settles, disable duplicate actions, and abort pending login on unmount. An abort rejection during browser dismissal is expected. The complete React integration is in [ChatProvider](../../chat/chat-provider.tsx), with the [Account screen](../../app/account.tsx) presenting its controls. The app uses the lifecycle controller for sign-out so all conversations stop dispatching before credentials are removed.

Closing the browser alone leaves device authorization pending, allowing approval on another device. The shared AbortController above stops polling and dismisses the browser on cancellation, completion, or failure. The adapter allows one open authentication browser at a time. It polls for up to fifteen minutes, honors slowdown responses, and aborts outstanding requests when its deadline expires. Keep sign-in in the foreground; the operating system may suspend polling in the background. The chat runtime separately closes/reopens durable work around background/foreground transitions, without promising background execution.

## Registered mobile client: Expo callback flow

If OpenAI has issued a public client for your app with Codex access and registered its callback, pass that identity explicitly:

```ts
import { makeRedirectUri } from 'expo-auth-session';
import { createCodexCredentialStore, createNativeCodexOAuth } from '@/pi/codex-auth';

const oauth = createNativeCodexOAuth({
  clientId: yourOpenAIRegisteredClientId,
  redirectUri: makeRedirectUri({ scheme: 'piagent', path: 'auth/callback' }),
});
// Inject oauth into provider.auth.oauth as shown above.
```

Set `expo.scheme` to your app's scheme in `app.json` and rebuild the development client after changing it. This repository uses `piagent`, producing `piagent://auth/callback`. The **exact URI** must be allowed by OpenAI for that client. A client ID is public configuration; do not embed a client secret in the app.

The adapter uses `AuthRequest` with code response type, PKCE, state, and `promptAsync`, which opens the native authentication session and receives the return URL. It additionally checks the callback address, requires one matching state and one authorization code, and exchanges the code with the same client, redirect, and verifier. Exchange and refresh use Expo request builders through cancellable fetch because their `performAsync` helpers do not expose an AbortSignal.

For the app factory, set `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` to the registered client ID and restart Metro. Leave it unset for device-code login. Pi's existing public desktop client does not automatically accept a mobile redirect; supplying its ID here does not register one. No suitable mobile client has been supplied, so the direct callback branch remains unverified end to end.

## Credentials and validation

Native credentials use Expo SDK 58 `expo-secure-store` asynchronously, through `ObservableCredentialStore`. One versioned JSON record is written atomically under a key scoped to the configured OAuth client. Read, write, and delete use the same Keychain service and `WHEN_UNLOCKED_THIS_DEVICE_ONLY` accessibility. Biometric prompts are disabled so ordinary token refresh does not interrupt the user. The operating system protects native credential storage; SQLite contains conversations only. Web uses tab-scoped `sessionStorage`, which is not an OS-protected credential vault.

Pi's `getAuth()` checks its five-minute minimum-validity window and performs refresh inside `CredentialStore.modify`. The store serializes the complete callback plus native commit, preventing duplicate rotations and ensuring logout waits for an active mutation. If refresh omits `refresh_token`, the existing token is retained. A provided replacement is saved before authentication resolves. If saving a rotated credential fails, the process retains it for a storage retry instead of refreshing the old token again; this cannot protect an unsaved rotation after process termination. Cancellation can stop a caller waiting, but cannot release a lock while a native write is still running.

Typed token errors retain only HTTP status and recognized protocol codes. `invalid_grant` on a 400/401 response clears the rejected credential under the existing mutation lock, avoiding a queued-delete deadlock. Network failures, timeouts, rate limits, and server failures retain credentials for retry. Native I/O errors are sanitized, surfaced, and never silently replaced with plaintext storage. Invalid stored records require sign-in again. The runtime keeps saved chats readable when authentication fails and blocks dispatch after a failed sign-out until removal succeeds.

The provider subscribes to the store's non-secret snapshot, so restored sessions, successful login, refresh invalidation, and sign-out drive one account state. Startup, send, and resume resolve auth through Pi; there is no separate refresh timer. System browser cookies are independent of the saved credential. iOS Keychain entries may survive reinstallations; explicit sign-out deletes this app's record. See [Expo SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/) for platform storage behavior.


Run from the project root:

```sh
pnpm test:compat
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
# Requires the rebuilt native development client connected to Metro:
node scripts/check-native-auth.mjs
```

The suite retains nine OAuth/device protocol checks plus fifteen integration regressions using the actual adapter, Models, Codex SSE provider, and Expo request/PKCE builders. Native boundaries and HTTP responses are substituted in tests. Another 23 credential-store tests cover restart persistence, refresh/logout serialization, cancellation, corruption, storage failures, and observer state. A successfully decoded refresh is saved even if its caller has just cancelled; login and pre-request cancellation still prevent credential changes. Coverage also includes callback/state validation, token conversion, safe errors, pending/slowdown responses, expiry, request headers, logout, and registered-client PKCE. The app's separate durable chat and SQLite tests do not substitute for signing in to a real account.

The native authentication probe passed on iOS 27/Hermes after terminating and relaunching the simulator app process. It restored a synthetic access JWT over 8 KiB and refresh token over 2 KiB from the actual Keychain, made one intercepted refresh for three concurrent Pi authentication calls, restored the rotated credential in a fresh store, and verified secure deletion. It used a unique validation key and no live account credentials or model requests.

Historical native checks: the iOS development app requested a real OpenAI device code, presented the native authentication permission prompt, and passed cancellation/retry checks. On 2026-09-24, the app was rebuilt and installed on a physical iPhone 15 Pro; its copy-success status appeared and the native clipboard contents were verified to equal the displayed real device code. TypeScript, lint, and all 40 existing protocol/compatibility tests passed. Those checks predate the durable chat migration. They establish the observed native sign-in presentation and clipboard behavior, not authenticated model streaming or the current SQLite/lifecycle integration. Live account approval, credential exchange, and authenticated tool execution require completed user sign-in. See the [verification record](../../../docs/ios-compatibility.md) for current gates and historical results.

References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo SDK 58 Clipboard](https://docs.expo.dev/versions/v58.0.0/sdk/clipboard/).
