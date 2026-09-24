# Expo Codex OAuth adapter

This TypeScript module implements Pi's public `OAuthAuth` interface using Expo SDK 58. Inject it into Pi's real `openai-codex` provider; Pi continues to own credential storage, refresh coordination, request authentication, and logout. Import the folder entry point, `@/pi/codex-auth`, in this app.

The default configuration uses OpenAI's device-code flow with the public client from Pi 0.87.1. A separate configuration supports Expo's authorization-code/PKCE flow when you have an OpenAI-issued public client registered for your mobile redirect and Codex access. Browser presentation currently supports **iOS only**.

## Requirements

- `@earendil-works/pi-ai` **0.87.1**, the version this adapter was implemented against.
- Expo **58.0.0-preview.6**, `expo-auth-session` **~58.0.4**, `expo-web-browser` **~58.0.2**, `expo-clipboard` **~58.0.1**, and their SDK-compatible dependencies. Use `npx @expo/agent-cli install expo-auth-session expo-web-browser expo-crypto expo-clipboard` when integrating into an existing Expo project. Rebuild the development client after adding the native clipboard dependency.
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
| `createCodexSession()` | Demo convenience factory: create Models, an in-memory credential store, the real Codex provider, and this adapter. |
| `CODEX_PROVIDER_ID` | `openai-codex`. |
| `MODEL_ID` | The demo's pinned catalog selection, `gpt-6-sol`; independent of the OAuth protocol. |

`core.ts` and `device-auth.ts` are internal protocol helpers. They remain free of native imports so their validation, timeout, and cancellation behavior can be tested in Node.

## Inject into Pi

```ts
import { createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { createNativeCodexOAuth } from '@/pi/codex-auth';

const models = createModels({
  credentials: new InMemoryCredentialStore(),
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

Keep this Models instance for the lifetime of the signed-in session and pass it to your AgentHarness. The provider's catalog and streaming implementation are unchanged. Select `transport: 'sse'` for native Codex requests, as the demo does in [harness.ts](../harness.ts).

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
  // Call after any active login has settled.
  await models.logout(CODEX_PROVIDER_ID);
}
```

The UI must handle rejected promises from `signIn` and `openSignInPage`, clear the displayed code when login settles, disable duplicate actions, and abort pending login on unmount. An abort rejection during browser dismissal is expected. The complete React integration is in [the demo screen](../../app/index.tsx).

Closing the browser alone leaves device authorization pending, allowing approval on another device. The shared AbortController above stops polling and dismisses the browser on cancellation, completion, or failure. The adapter allows one open authentication browser at a time. It polls for up to fifteen minutes, honors slowdown responses, and aborts outstanding requests when its deadline expires. Keep the app in the foreground; background/suspend behavior has not been validated.

## Registered mobile client: Expo callback flow

If OpenAI has issued a public client for your app with Codex access and registered its callback, pass that identity explicitly:

```ts
import { makeRedirectUri } from 'expo-auth-session';
import { createNativeCodexOAuth } from '@/pi/codex-auth';

const oauth = createNativeCodexOAuth({
  clientId: yourOpenAIRegisteredClientId,
  redirectUri: makeRedirectUri({ scheme: 'piagent', path: 'auth/callback' }),
});
// Inject oauth into provider.auth.oauth as shown above.
```

Set `expo.scheme` to your app's scheme in `app.json` and rebuild the development client after changing it. This repository uses `piagent`, producing `piagent://auth/callback`. The **exact URI** must be allowed by OpenAI for that client. A client ID is public configuration; do not embed a client secret in the app.

The adapter uses `AuthRequest` with code response type, PKCE, state, and `promptAsync`, which opens the native authentication session and receives the return URL. It additionally checks the callback address, requires one matching state and one authorization code, and exchanges the code with the same client, redirect, and verifier. Exchange and refresh use Expo request builders through cancellable fetch because their `performAsync` helpers do not expose an AbortSignal.

For the demo factory, set `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` to the registered client ID and restart Metro. Leave it unset for device-code login. Pi's existing public desktop client does not automatically accept a mobile redirect; supplying its ID here does not register one. No suitable mobile client has been supplied, so the direct callback branch remains unverified end to end.

## Credentials and validation

The demo's credentials are held in `InMemoryCredentialStore`; sign-out, reload, or process termination clears them. Pi uses the adapter's `refresh` and `toAuth` methods during subsequent requests. Logout clears local credentials; system browser cookies are managed separately. Secure persistence would require a separate credential-store implementation.

Run from the project root:

```sh
pnpm test:compat
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
```

The suite includes nine OAuth/device protocol checks in addition to the 31 dependency checks. Tests cover callback/state validation, token conversion, safe errors, pending/slowdown responses, cancellation, and expiry. They do not substitute for signing in to a real account.

The iOS development app has requested a real OpenAI device code, presented the native authentication permission prompt, and passed cancellation/retry checks. On 2026-09-24, the app was rebuilt and installed on a physical iPhone 15 Pro; its copy-success status appeared and the native clipboard contents were verified to equal the displayed real device code. TypeScript, lint, and all 40 existing protocol/compatibility tests passed. Account approval, credential exchange, authenticated model streaming, and the local tool loop remain pending a completed user sign-in. Release-build and background/suspend behavior have not been verified. See the [verification record](../../../docs/ios-compatibility.md) for the earlier integration checks.

References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo SDK 58 Clipboard](https://docs.expo.dev/versions/v58.0.0/sdk/clipboard/).
