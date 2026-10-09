# Pi OAuth callback receiver

This local Expo module receives the modern Pi OpenAI provider's fixed redirect, `http://127.0.0.1:1455/auth/callback`, inside the iOS app. Its native implementation is Swift-only, using Apple Network and the Expo Modules 2.0 `@ExpoModule` / `@JS` macros. It contains no Objective-C, Kotlin, token exchange, or credential storage.

The module is a transport adapter for browser authorization with PKCE. It does not implement device-code authorization. Pi's modern `openai` provider has no device-code route in the installed `pi-ai` 1.1.0; the separate legacy `openai-codex` provider has that flow. See the [OpenAI adapter documentation](../../src/pi/openai-auth/README.md) for the public Pi `OAuthAuth` integration and versioned SDK sources.

## Integration and API

[`src/PiOAuthCallbackModule.ts`](src/PiOAuthCallbackModule.ts) loads `PiOAuthCallback` through Expo's `requireOptionalNativeModule`. Other platforms or older builds without this native module retain the OAuth adapter's manual callback fallback.

| Method | Contract |
| --- | --- |
| `start(state): Promise<string>` | Starts one session and returns its opaque ID only after the listener reports ready. Rejects invalid state, an active session, a port conflict, or startup failure. |
| `waitForCallback(sessionId): Promise<string>` | Resolves once with the complete callback URL. A callback received before this call is retained until consumed or expired. A second waiter or delivery is rejected. |
| `stop(sessionId): Promise<void>` | Stops that session and waits for listener cancellation. Repeated or stale IDs are harmless. Rejects an outstanding waiter unless a callback was already accepted, in which case the accepted callback wins. |

[`browser.ts`](../../src/pi/openai-auth/browser.ts) starts the receiver with the existing Expo `AuthRequest.state`, registers the callback waiter, then presents the Expo authentication browser. It arbitrates native reception, browser completion, and cancellation. After reception it dismisses and drains the Expo browser before allowing another login; its `finally` block stops the native session. If native startup is unavailable, the existing Expo/browser path and same-request manual fallback remain available.

The returned URL still passes through the TypeScript adapter's full callback validation before token exchange. The native module does not generate state or PKCE, interpret tokens, persist credentials, or make an outbound request. Expo owns browser presentation; Pi's `Models` and the app's `OAuthAuth` adapter own authentication. Manual entry reuses the original authorization request and verifier.

## Native lifetime and request bounds

[`PiOAuthCallbackModule.swift`](ios/PiOAuthCallbackModule.swift) is a plain public macro-annotated class. Its async methods forward to the private [`OAuthCallbackServer`](ios/OAuthCallbackServer.swift) actor, which owns listeners, connections, continuations, and timers. Network callbacks enter that actor from a serial dispatch queue; session IDs prevent late callbacks or cleanup from affecting a later login. The Expo `willDestroy()` hook calls `stopAll()` and prevents queued calls from starting new work during teardown.

The listener binds explicitly to IPv4 `127.0.0.1:1455` using `NWParameters.requiredLocalEndpoint`, with endpoint reuse disabled. It does not bind a wildcard or LAN address. An occupied port fails startup rather than changing the SDK redirect. `NWListener.cancel()` stops new connections; the actor separately closes accepted connections and waits for the listener's cancelled state before rebinding. Apple's `acceptLocalOnly` option means the local link, so it is not used as a substitute for the exact loopback binding. [Apple endpoint API](https://developer.apple.com/documentation/network/nwparameters/requiredlocalendpoint), [listener cancellation](https://developer.apple.com/documentation/network/nwlistener/cancel()), [local-link option](https://developer.apple.com/documentation/network/nwparameters/acceptlocalonly).

[`OAuthCallbackHTTP.swift`](ios/OAuthCallbackHTTP.swift) accepts a bodyless `GET` to the exact callback path with one exact `Host: 127.0.0.1:1455` header and one matching state. A successful callback requires one nonempty `code` and `client_id`; a matching OAuth error callback is returned for the TypeScript adapter to reject. Duplicate or incomplete authorization parameters and malformed requests are rejected without consuming the pending login. Responses use static HTML, `Cache-Control: no-store`, `Connection: close`, and restrictive content security headers; they never echo the URL, code, or state.

Bounds are 16 KiB of request headers, eight accepted connections, five seconds per connection, five seconds for startup, and ten minutes for a login or an unconsumed callback. Fragmented HTTP reads are accumulated within the same bounds. This is a foreground authentication receiver; it makes no guarantee of continued execution after iOS suspends the app.

## Expo Modules 2.0 setup

The app uses Expo SDK 58. The initial local Apple module scaffold was created with `create-expo-module --local --platform apple`; the template's definition DSL was replaced with the new Swift macros. [`expo-module.config.json`](expo-module.config.json) registers the Swift module class, and the [podspec](ios/PiOAuthCallback.podspec) declares `ExpoModulesCore`, Apple's `Network` framework, and Swift 6.0. Native files belong in this local module, not generated application `ios/` files.

The installed `expo-modules-autolinking` injects the macro compiler into pods that directly depend on `ExpoModulesCore`. No `s.use_expo_modules_macros!` helper or hand-written compiler flags are needed with these installed packages. `@JS` async methods become JavaScript promises; no event subscription or legacy `AsyncFunction` definition is required.

The Expo Agent CLI was consulted through its help and `skills:list` commands. This installation exposes no documentation command and no Expo Modules package skill; the available package skill is SQLite. The official [Expo Modules 2.0 introduction](https://expo.dev/blog/an-early-look-at-expo-modules-2-0) and installed macro/core/autolinking source supplied the missing API guidance. See also the [local module setup guide](https://docs.expo.dev/modules/get-started/) and [create-expo-module CLI reference](https://docs.expo.dev/modules/create-expo-module/).

## Verification

Adding or changing Swift requires rebuilding the native app; a Metro reload cannot install the module. From the app root, explicitly select a simulator UDID when rebuilding:

```sh
npx @expo/agent-cli run:ios --device "<SIMULATOR_UDID>" --configuration Debug
npx @expo/agent-cli lint
npx @expo/agent-cli typecheck
```

Runtime pass/fail results must be reported from an actual run, not inferred from this documentation or a successful build. Verification is restricted to the simulator; physical-device use is installation only.
