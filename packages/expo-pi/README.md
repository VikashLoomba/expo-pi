# @automatalabs/expo-pi

Run [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, and the portable `@earendil-works/pi-durable` APIs) in Expo and React Native apps on iOS and Android.

Pi's code runs on Hermes, but native Metro can't bundle it as published:

```text
Invalid call at line 13: import(__rewriteRelativeImportExtension(specifier))
```

A few Pi modules load desktop code with `import(specifier)`, where the specifier is a variable. Metro rejects that, even though Pi only takes those branches on Node or Bun. Hermes also has no `crypto.getRandomValues`, which Pi uses to generate IDs. `expo-pi` fixes both with one line of Metro config.

## Install

```sh
npx expo install @automatalabs/expo-pi @earendil-works/pi-agent-core
```

`pi-agent-core` depends on `pi-ai`, so either package works as the one you install. If your code imports from `@earendil-works/pi-ai` directly, install it too; package managers such as pnpm only allow imports of packages you list.

Wrap your Metro config. Create `metro.config.js` in the project root if you don't have one:

```js
const { getDefaultConfig } = require('expo/metro-config');
const { withPi } = require('@automatalabs/expo-pi/metro');

module.exports = withPi(getDefaultConfig(__dirname));
```

Restart Metro with a cleared cache after changing its config: `npx expo start --clear`.

That's all. You don't need a custom entry file, a config plugin, or a separate `expo-crypto` install; `expo-crypto` ships as a dependency of this package and autolinks. It's included in Expo Go, so this works in Expo Go and in development builds.

`withPi` keeps any transform worker and resolver already in the config and delegates to them, so it can be combined with other Metro wrappers such as NativeWind.

### Optional web clients

Metro also rejects Pi's variable desktop imports when it builds a browser bundle. If your Expo app supports web, enable the same client rewrite explicitly:

```js
module.exports = withPi(getDefaultConfig(__dirname), { web: true });
```

The default remains iOS and Android only. The option applies to **web client** bundles; Node/API-route and React Server bundles stay unchanged. Browsers retain their existing secure `crypto.getRandomValues` implementation. Desktop-only OAuth loaders still reject when called: provide an OAuth adapter suited to your app, or use another supported credential path. This option handles Pi's Metro compatibility; other browser dependencies can have their own requirements. For example, Expo SQLite web needs its WASM asset configuration and cross-origin isolation headers.

## What it changes

`@automatalabs/expo-pi` doesn't replace or copy any of Pi's modules. In **iOS and Android** bundles (and **web clients** with `{ web: true }`), as Metro transforms a file from an `@earendil-works/*` package, it makes three targeted changes:

- **Variable `import()` calls become rejected promises.** Each `import(specifier)` whose specifier isn't a string literal is replaced with a call that rejects with `[expo-pi] Cannot load <specifier>: ...`. The error only surfaces if that code actually runs, which on a phone means you invoked a desktop-only feature.
- **The secure-random bridge is imported where it's needed.** A module that calls `crypto.getRandomValues` gets an import of `@automatalabs/expo-pi/crypto`, which installs `getRandomValues` from `expo-crypto` if the runtime lacks it. An existing implementation is never replaced, and `crypto.subtle` is not provided.
- **Chord uses string array descriptor keys.** Hermes can pass a numeric key directly into a Proxy trap, which breaks Chord's strict JSON copy of tracked arrays during durable recovery. The transform changes only the indexed descriptor lookup in Chord's JSON module to `String(index)`, preserving its validation and leaving symbol-key lookups untouched.

Line numbers are preserved, so stack traces and source maps still point at Pi's code. Web bundles are unchanged by default. Server bundles (API routes, React Server) and every other package are always left unchanged. No files in `node_modules` are modified.

With Pi 1.2.0, this means native bundles behave as follows:

| Pi feature | Behavior on iOS and Android |
| --- | --- |
| Default `AuthContext.fileExists` | Returns `false`: there are no desktop credential files. |
| Desktop OAuth loaders (`auth/oauth/load`) | Reject with the error above. Inject a mobile `OAuthAuth` implementation instead. |
| Google ADC credential-file detection, Bun environment fallback | Inactive, because Pi only runs these on Node or Bun. Explicit keys and environment values still work. |
| IDs (`utils/uuid`) | Use `crypto.getRandomValues` through the bridge. |

## Using Pi on a device

- Supply credentials explicitly through Pi's injectable interfaces, for example `createModels({ credentials, authContext })` with an `InMemoryCredentialStore` or your own secure store.
- Use `Agent` from `@earendil-works/pi-agent-core` with an explicit `streamFn` backed by your `Models` instance. It keeps its transcript in memory. Pi 1.0 removed the old `AgentHarness` and `MemorySessionRepo` APIs. Avoid Node environments and the coding-agent CLI, which need a filesystem and shell.
- For persistent conversations, use `Harness` from `@earendil-works/pi-durable` with a native storage adapter. The demo's [Expo SQLite adapter](../../src/pi/storage/index.ts) supplies `SqliteDatabase` to Pi's portable `SqliteStorage`; do not import `storage/sqlite/node` on a device. Install `pi-durable`, `pi-ai`, and `expo-sqlite` as direct dependencies when using that integration. Set the harness's `settings.stream.transport` to `'sse'` for Codex.
- Import only the providers your app needs, for example `@earendil-works/pi-ai/providers/openai-codex`.
- For `openai-codex`, pass `transport: 'sse'` to `Agent` or to `models.streamSimple(...)`. Its WebSocket path uses Node/Bun constructor options that React Native doesn't support.

The wrapper handles Metro and secure random; persistence and OS lifecycle remain application responsibilities. The demo now uses a shared durable Harness and SQLite storage across chats, while the `Agent` pattern above remains suitable for in-memory sessions.

## Compatibility

**Pi:** the wrapper does not enforce a particular Pi version. The app pins **Pi AI / Pi Durable / Chord 1.2.0**. Earlier Agent-based iOS and Android Hermes bundles built with Pi 1.0.0; current durable bundles and native runtime results are recorded separately. Earlier checks covered Pi AI 0.80.1 through 0.87.1 (15 releases), with native bundles built for 0.84.4 and 0.87.1. The transform follows Pi's published code; future releases still need separate API, bundle, and device-runtime validation.

**Expo SDK:** `expo-crypto` is a native module whose version must match your Expo SDK. Like Expo's own packages, each `@automatalabs/expo-pi` release targets one SDK and depends on the matching `expo-crypto`. This release targets **Expo SDK 58**; its peer dependency on `expo` says so. Current bundle checks use SDK **58.0.7**, React Native **0.88.0-rc.4**, and `expo-crypto` **58.0.6**. Android bundles build; an Android device runtime has not been verified yet.

## Debugging

Set `EXPO_PI_DEBUG=1` when starting Metro to log each file it changes:

```sh
EXPO_PI_DEBUG=1 npx expo start --clear
```

## Why a Metro wrapper and not a config plugin?

Expo config plugins run during `npx expo prebuild` and modify the native iOS and Android projects. They can't change how Metro bundles JavaScript, and that's where this fix belongs. Metro reads only `metro.config.js`, so wrapping it is the standard mechanism, the same one NativeWind and Sentry use. No native configuration is needed.

## Development

```sh
pnpm --filter @automatalabs/expo-pi build   # compile src/ to build/
```

For a new Expo SDK, update the `expo-crypto` dependency and the `expo` peer dependency to that SDK's versions, then rebuild and test a development client.

## License

MIT
