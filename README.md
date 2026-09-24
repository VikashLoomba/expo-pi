# Pi Agent Harness on Expo / iOS

This repository contains [`@automatalabs/expo-pi`](packages/expo-pi/README.md), which lets Pi run in Expo apps on iOS and Android, and a demo app that uses it.

An on-device Pi **AgentHarness** app using Pi's real **`openai-codex` provider**, with `gpt-6-sol` from the pinned catalog. Sign in with your ChatGPT account. No API key or fixture provider is used.

## Run

```sh
pnpm install --frozen-lockfile
npx @expo/agent-cli dev --ios --local --dev-client --detach --wait-ready
```

Use a development build for OAuth; Expo Go cannot provide the app's production redirect scheme. If an older detached server is running, stop it with `npx @expo/agent-cli dev:stop`. Rebuild an older development client to remove the previous `CodexCallback` native module.

1. Tap **Sign in with ChatGPT**. The app requests a real one-time device code from OpenAI and automatically copies it to your clipboard. The status confirms whether copying succeeded; manual entry remains available if it fails.
2. Tap **Open sign-in page**, sign in, and paste the code. The page opens with Expo `openAuthSessionAsync` / Apple's `ASWebAuthenticationSession`.
3. Alternatively, visit `https://auth.openai.com/codex/device` on your physical phone and enter the code there. Keep this app open; it polls OpenAI for approval. This lets your phone use its own passkey without a simulator Bluetooth connection.
4. After authorization, the app exchanges the returned authorization code with its PKCE verifier and passes the credential to Pi.
5. Tap **Run prompt**. The default prompt asks the model to call `add_numbers(19, 23)`. Pi executes the tool on the device, sends the result back, and displays the streamed final response.

OpenAI currently labels device-code login beta and requires it to be enabled in the account's ChatGPT security settings or workspace permissions. See [OpenAI's device-code instructions](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

**Cancel** stops the active login or harness operation. Closing the device sign-in browser returns to the app while approval remains pending, so you can finish on another device. The code expires after fifteen minutes. Login completion, failure, cancellation, or screen unmount closes any browser the app opened.

OAuth credentials remain in Pi's in-memory credential store across prompts. Pi owns credential storage, serialized refresh, request auth, and logout. **Sign out** clears that store; app reload/termination also loses credentials. Browser cookies are controlled by the system authentication session. Each prompt starts a fresh in-memory conversation.

## Pi and Expo authentication

See the [Codex OAuth module README](src/pi/codex-auth/README.md) for its public API, integration examples, and lifecycle requirements. The Metro and runtime setup that lets Pi bundle for iOS and Android is packaged as [`@automatalabs/expo-pi`](packages/expo-pi/README.md).

Pi's public `Provider.auth.oauth` contract is pluggable: `login`, `refresh`, and `toAuth` can be replaced without changing the model catalog, streaming transport, or AgentHarness. This app injects an Expo adapter through `models.setProvider(...)` and uses `models.login(...)` / `models.logout(...)` normally.

There is no custom native authentication module, localhost listener, Node OAuth import, desktop credential import, or callback proxy.

Two explicit configurations are supported:

- **Default: existing Pi/Codex client, device-code login.** Uses the device-code protocol already implemented by Pi 0.87.1 and documented by OpenAI. OpenAI's server returns the authorization code and verifier through polling. Its server-side device callback is used during token exchange; it never calls back into the app. Expo's authentication session presents the sign-in page, and the app dismisses it when polling completes. This is a device authorization flow, not an authorization-code redirect flow.
- **Registered mobile client: Expo authorization-code login.** If OpenAI issues your app a public OAuth client with Codex access and registers `piagent://auth/callback`, set `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` to that client ID and restart Metro. `makeRedirectUri` constructs the app callback and `AuthRequest.promptAsync()` owns the browser/return flow. Expo generates PKCE/state; the app additionally validates the exact callback and rejects duplicate state/code parameters. The same client is used for exchange and refresh. A client ID is public configuration, not a secret. Do not set it to Pi's desktop client ID expecting that to register a mobile redirect.

The callback acceptance requirement belongs to OpenAI's authorization server, not Pi. In a live browser comparison, the existing Codex client returned an authentication error for `piagent://auth/callback`, while the same request using its desktop localhost callback reached the login page. No user credentials were entered in that comparison. The registered-mobile-client branch cannot be verified end to end until an appropriate client exists.

References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/).

## Validation

```sh
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
pnpm test:compat
npx @expo/agent-cli doctor
npx expo export --platform ios --platform android --source-maps
```

The protocol unit tests are separate from the running app. Live harness verification requires your actual ChatGPT authorization. See [compatibility and verification notes](docs/ios-compatibility.md) for observed results and pending checks. SDK 58 and React Native are prereleases here. App Store suitability and permission to distribute a third-party Codex client are not established by these tests.

## Main files

- `src/app/index.tsx`: sign-in/out, device code and browser actions, prompt, streamed output, tool result, cancellation and runtime diagnostics.
- `src/pi/codex-auth/index.ts`: Expo OAuth adapter injected into Pi's public auth interface; in-memory credential store.
- `src/pi/codex-auth/core.ts`: callback validation, cancellable token exchange and Pi credential conversion.
- `src/pi/codex-auth/device-auth.ts`: OpenAI device authorization, polling, timeout and cancellation.
- `src/pi/harness.ts`: real Pi harness and `add_numbers` tool. Explicit SSE uses Expo's native streaming fetch.
- `metro.config.js`: wraps the Expo Metro config with `withPi` from `@automatalabs/expo-pi`.
- `packages/expo-pi/`: the `@automatalabs/expo-pi` package whose Metro transform makes Pi's desktop-only dynamic imports bundle on native and adds the secure-random bridge.
