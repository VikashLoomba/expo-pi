# Pi / Expo native compatibility verification

Verified locally on 2026-09-23 (America/Los_Angeles).

## Exact versions and source

| Component | Version |
| --- | --- |
| Expo | 58.0.0-preview.6 |
| Expo CLI (`npx expo --version`) | 58.0.6 |
| React Native | 0.88.0-rc.1 |
| React | 19.3.0 |
| Pi AI / Agent Core | 0.87.1, exact-pinned |
| OpenAI SDK in Pi's dependency graph | 6.40.0 |
| expo-crypto | 58.0.2 |
| expo-auth-session / expo-web-browser | 58.0.4 / 58.0.2 |
| expo-dev-client | 58.0.6 |
| Node / pnpm | 24.5.0 / 10.33.0 |
| Simulator | iPhone 18 Pro, iOS 27.0, Hermes |
| Xcode | 27.0 (27A266a) |

The app initially had no Pi dependencies. npm's current release for both Pi packages was 0.87.1. Upstream HEAD was `b45597504eeaba1f11a9920a1d1048c361ed4b8e`, matching the previous redirects' reviewed commit. Installed JavaScript and its source maps were inspected, alongside a fresh upstream checkout.

Three of the four original shim targets matched upstream source exactly. Upstream `env-api-keys.ts` had an additional `typesafe` mapping absent from the published npm 0.87.1 artifact. The local shim was corrected to follow the **installed artifact**, and a test covers that distinction.

The selected provider is now `openai-codex`, with `gpt-6-sol` from the installed Pi catalog. Its transport and model definitions remain unchanged. The app replaces only the provider's desktop OAuth implementation through Pi's public `Provider.auth.oauth` interface.

## Reproduced failure and narrow replacements

A reachable app screen imported Pi's public root APIs and a selected provider with no Metro redirects. The native iOS export failed in `pi-ai/dist/env-api-keys.js`:

```text
Invalid call at line 13: import(__rewriteRelativeImportExtension(specifier))
```

The relevant paths are:

```text
app → pi-agent-core → pi-ai → auth/context
app → pi-ai/providers/openai-codex → auth/helpers → auth/oauth/load
app → pi-ai/providers/openai-codex → openai-codex-responses.lazy
    → openai-codex-responses → utils/provider-env
```

Metro must statically analyze dependency expressions even if desktop-only code would never execute on Hermes. Native redirects operate on the normally resolved file and verified owning package. They delegate to an existing resolver, and leave web/server resolution intact.

| Target | Reason | Native behavior |
| --- | --- | --- |
| `auth/context` | Variable imports of Node filesystem / OS | Keep auth contract; desktop credential-file discovery returns false |
| `env-api-keys` | Variable imports of Node filesystem / OS / path | Keep explicit environment lookup; omit Google ADC file discovery |
| `utils/provider-env` | Bun `/proc/self/environ` fallback requires `node:fs` | Keep scoped and existing ambient environment lookup |
| `auth/oauth/load` | Variable imports of desktop OAuth implementations | Explicit unsupported error on invocation unless native loaders are registered |

The OAuth loader target is reached by the Codex factory. Its desktop implementations stay out of the native graph; the app injects its mobile implementation after constructing the real provider. The app also injects a non-discovering auth context and an `InMemoryCredentialStore` rather than reading desktop credentials.

The resolver rejects unreviewed Pi AI versions. Pi dependencies are exact-pinned. On upgrades, re-inspect both the installed package and upstream source, compare contracts, then rerun bundles and device checks before changing the guard. No node_modules files were patched.

## Runtime adaptation

An actual iOS/Hermes probe found `fetch`, `ReadableStream`, `TextEncoder`, `TextDecoder`, `AbortController`, `structuredClone`, and `BigInt` available, but `crypto` / `crypto.getRandomValues` missing. SDK 58's inspected `expo/src/winter/runtime.native.ts` already installs Expo's streaming fetch by default.

`index.js` imports `src/pi/runtime.native.ts` before `expo-router/entry`. That module conditionally exposes **only** `expo-crypto.getRandomValues` through `globalThis.crypto`. It preserves an existing implementation. It does not claim to provide `crypto.subtle` or all Web Crypto. Expo Go already includes this native module.

Afterward, the running Hermes app passed secure random generation, UTF-8 encode/decode, structured cloning of BigInt, AbortController state, and ReadableStream construction probes. No fetch, stream, encoding, Buffer, filesystem, or Node builtin polyfills were added.

## Codex dependency graph and OAuth

The final iOS and Android source maps contain only the `openai-codex` factory/catalog plus Pi's root-exported `faux` utility. The app never selects `faux`. Neither Pi's desktop `auth/oauth/openai-codex` nor the Node harness environment appears in the graph.

Pi's actual `openai-codex-responses` adapter streams directly to ChatGPT. Its optional Node zlib/user-agent/proxy paths are runtime-guarded. The WebSocket path assumes the Node/Bun constructor signature for authentication headers; React Native uses a different signature. The harness explicitly selects `transport: 'sse'` so Pi uses Expo SDK 58's default native streaming fetch. No replacement model transport or backend agent loop was added.

### Expo OAuth adapter

The adapter is packaged in `src/pi/codex-auth/`; its [module README](../src/pi/codex-auth/README.md) documents integration and browser lifecycle ownership.

Pi's public `Provider.auth.oauth` interface is the integration point. The app replaces only `login`, `refresh`, and `toAuth`; Pi continues to own credentials, serialized refresh and request authentication. Pi's desktop redirect is not a requirement of AgentHarness or Models.

The previous `SFSafariViewController` plus native loopback receiver was removed. There is no `CodexCallback` module or listener in the current source. The iOS app uses Expo SDK 58 `ASWebAuthenticationSession` through `openAuthSessionAsync` or `AuthRequest.promptAsync`.

With the existing Codex public client, the default is OpenAI's device-code flow, matching Pi 0.87.1's `auth/oauth/openai-codex` protocol. The app requests a code, emits Pi's `device_code` notification, and polls with the server-provided interval. Pending and slowdown responses are handled separately; slowdown increases the interval by five seconds. The fifteen-minute deadline also cancels an in-flight request. Cancellation stops fetches/timers and closes an open authentication browser. Closing the device-code browser alone leaves authorization pending so the user can approve it on a physical phone. No Bluetooth pairing or incoming device callback is needed for this route.

After approval, Expo's `AccessTokenRequest` builds the exchange using OpenAI's returned code/verifier and its server-side device callback. `RefreshTokenRequest` builds refresh requests. Their request builders are sent through cancellable fetch because their built-in `performAsync` does not accept an AbortSignal. Response errors omit remote bodies and credentials. Tokens are converted to Pi's OAuthCredential, including expiry and ChatGPT account ID.

For a separately registered mobile OAuth client, `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` enables `makeRedirectUri({ scheme: 'piagent', path: 'auth/callback' })` and `AuthRequest.promptAsync`. Expo creates PKCE/state and handles the system callback. Additional validation compares custom-scheme URL components (their origin is `null`) and requires one matching state and one code. This branch requires an OpenAI registration allowing the app callback and Codex access; no such registration has been supplied, so end-to-end validation is pending.

A live browser comparison of otherwise identical authorization requests showed the existing client returning an authentication error for `piagent://auth/callback` and reaching the login page for the desktop localhost URI. This establishes that changing only the redirect did not work in that check; it is not a complete enumeration of the server's allowlist. An unauthenticated HTTPS request to the device-code endpoint returned 200 with the expected device code fields; credentials were not entered or imported.

References: [SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [OpenAI device-code authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## Harness integration

The screen uses `AgentHarness.create`, `MemorySessionRepo`, `createModels`, `InMemoryCredentialStore`, `openaiCodexProvider`, and Pi's exported TypeBox schema constructor. `add_numbers` validates numeric arguments through Pi, returns `{sum, platform, runtime: 'on-device'}`, and has no filesystem or shell access. Text deltas and tool/run events update React state as they arrive.

Pi 0.87.1's context cancellation stops observation, not necessarily the underlying operation. The app's AbortController therefore explicitly calls `lane.requestAbort(operationId, BACKGROUND_CONTEXT)` and awaits `lane.drive` settlement. This routes cancellation through Pi's durable operation lifecycle to its provider AbortSignal. The abort listener, event listeners, harness, and repository are cleaned up at the end of each run. Credentials survive runs until sign-out or app termination.

## Observed verification

| Check | Result |
| --- | --- |
| Unmodified reachable Pi graph / iOS export | Failed with variable-import error as expected |
| Redirected Pi graph / iOS Hermes export | Passed |
| Final Codex graph / iOS production-style export | Passed, 4.9 MB Hermes bytecode |
| Final Codex graph / Android production-style export | Passed, 5.0 MB Hermes bytecode |
| Initial harness iOS launch | Passed in Expo Go on iOS 27.0 / Hermes, before OAuth addition |
| Current iOS development build | Rebuilt, signed for simulator and installed successfully after removing the callback module; 0 errors and 1 upstream script warning |
| Current development-client runtime | Passed on iOS 27 / Hermes as `com.vikashloomba.piagent`; new device-code screen rendered |
| Live device-code request | Passed from the rebuilt iOS app against OpenAI; one-time code displayed |
| Expo authentication browser | Native ASWebAuthenticationSession permission prompt appeared for auth.openai.com |
| Live login cancellation / retry | Cancel dismissed the native authentication prompt, cleared the code, returned to signed-out state; subsequent login received a fresh code |
| Registered mobile callback flow | Implemented with AuthRequest.promptAsync; requires an OpenAI-issued mobile client to verify end to end |
| Native runtime API probes | Passed after secure-random bridge |
| Current runtime error check | No errors observed in the post-retry two-second debugger capture window |
| TypeScript | Passed |
| ESLint | Passed |
| Expo Doctor | 20/20 passed |
| Redirect/shim tests, including installed-mapping regression | 40/40 passed (31 compatibility + 9 OAuth/device protocol checks) |
| Authenticated Codex streaming / on-device tool / final response | Pending real ChatGPT sign-in |
| Cancellation during live Codex streaming | Pending real ChatGPT sign-in |
| Android device/Hermes runtime | Not run; user requested iOS focus |
| Standalone release app / physical iPhone | Not run; development simulator build only |

The starter template had a web ref type mismatch and a hydration effect rejected by the installed React lint rules. The web tab uses the current Pressable ref type, and hydration uses `useSyncExternalStore`. These are small template fixes to satisfy the required checks, with no suppressed lint/type rules.

## Remaining production work

This is a minimal development integration, with a fresh in-memory session per prompt. Persistent conversations, secure persisted user credentials, app-owned authenticated gateways, background/suspend lifecycle handling, physical-device/release validation, and broader tool/provider coverage are separate work. Desktop OAuth and Node execution adapters remain excluded. Authentication browser presentation is currently iOS-only. Physical-device and suspend/resume behavior remain to be verified; no background execution is assumed. A registered mobile client is required to validate the direct Expo callback branch.

The SDK/RN versions are prereleases. Package installation reports peer-range warnings for Reanimated/Worklets; Expo Doctor nevertheless passes. Metro also reports an upstream virtualized-lists private-export fallback warning. Neither blocked the observed native bundles or iOS launch, but they remain upstream prerelease caveats.

The current rebuild reported **Build Succeeded**, zero errors and one upstream Expo Dev Launcher build-script dependency warning. No compiler settings or dependency sources were changed. The detached agent-cli readiness wait expired while compilation was still running; the build continued, installed successfully, and Metro subsequently became ready. No credential exchange or live model run is claimed yet; the rebuilt simulator app displayed a real code for user authorization.
