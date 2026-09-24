# @automatalabs/expo-pi

Run [Pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`) in Expo and React Native apps on iOS and Android.

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

## What it changes

`@automatalabs/expo-pi` doesn't replace or copy any of Pi's modules. In **iOS and Android** bundles, as Metro transforms a file from an `@earendil-works/*` package, it makes two changes:

- **Variable `import()` calls become rejected promises.** Each `import(specifier)` whose specifier isn't a string literal is replaced with a call that rejects with `[expo-pi] Cannot load <specifier>: ...`. The error only surfaces if that code actually runs, which on a phone means you invoked a desktop-only feature.
- **The secure-random bridge is imported where it's needed.** A module that calls `crypto.getRandomValues` gets an import of `@automatalabs/expo-pi/crypto`, which installs `getRandomValues` from `expo-crypto` if the runtime lacks it. An existing implementation is never replaced, and `crypto.subtle` is not provided.

Line numbers are preserved, so stack traces and source maps still point at Pi's code. Web, server (API routes, React Server) bundles, and every other package are left unchanged. No files in `node_modules` are modified.

With Pi 0.87.1, this means native bundles behave as follows:

| Pi feature | Behavior on iOS and Android |
| --- | --- |
| Default `AuthContext.fileExists` | Returns `false`: there are no desktop credential files. |
| Desktop OAuth loaders (`auth/oauth/load`) | Reject with the error above. Inject a mobile `OAuthAuth` implementation instead. |
| Google ADC credential-file detection, Bun environment fallback | Inactive, because Pi only runs these on Node or Bun. Explicit keys and environment values still work. |
| IDs (`utils/uuid`) | Use `crypto.getRandomValues` through the bridge. |

## Using Pi on a device

- Supply credentials explicitly through Pi's injectable interfaces, for example `createModels({ credentials, authContext })` with an `InMemoryCredentialStore` or your own secure store.
- Use `MemorySessionRepo` or your own session repository. Avoid the Node harness environment and the coding-agent CLI, which need a filesystem and shell.
- Import only the providers your app needs, for example `@earendil-works/pi-ai/providers/openai-codex`.
- For `openai-codex`, pass `streamOptions: { transport: 'sse' }`. Its WebSocket path uses Node/Bun constructor options that React Native doesn't support.

## Compatibility

**Pi:** there is no pinned Pi version. The transform works on Pi's code as published instead of on copies of it, so changes Pi makes to these modules are picked up automatically. Every module of Pi AI 0.80.1 through 0.87.1 (15 releases) has been checked, and iOS and Android bundles were built with 0.84.4 and 0.87.1. If a future Pi release needs something else that Metro or Hermes doesn't support, bundling fails with Metro's error rather than behaving differently at runtime.

**Expo SDK:** `expo-crypto` is a native module whose version must match your Expo SDK. Like Expo's own packages, each `@automatalabs/expo-pi` release targets one SDK and depends on the matching `expo-crypto`. This release targets **Expo SDK 58**; its peer dependency on `expo` says so. It was tested with SDK 58.0.0-preview.6 and React Native 0.88.0-rc.1, on Hermes on iOS 27. Android bundles build; an Android device runtime has not been verified yet.

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
pnpm --filter @automatalabs/expo-pi test    # build, type-level checks, Node tests
```

For a new Expo SDK, update the `expo-crypto` dependency and the `expo` peer dependency to that SDK's versions, then rebuild and test a development client.

## License

MIT
