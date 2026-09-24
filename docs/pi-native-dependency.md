# Using Pi as an Expo native dependency

This compatibility layer lets the runtime-neutral portions of `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` bundle under Expo Metro and run in Hermes. It is reviewed for **Pi 0.87.1** and **Expo SDK 58.0.0-preview.6 / React Native 0.88.0-rc.1**.

## What is replaced

Native Metro rejects variable `import(specifier)` calls even when their desktop-only branches will not execute. The unmodified reachable Pi graph failed with:

```text
Invalid call at line 13: import(__rewriteRelativeImportExtension(specifier))
```

`metro/with-pi-native.cjs` delegates to the existing resolver, verifies that the resolved file belongs to the pinned Pi AI package, and substitutes only these modules for iOS/Android:

| Pi module | Native behavior |
| --- | --- |
| `auth/context` | Preserve the AuthContext contract; desktop credential-file discovery returns false |
| `env-api-keys` | Preserve explicit provider/environment mappings; omit Google ADC filesystem discovery |
| `auth/oauth/load` | Preserve injectable loader registration; fail explicitly if desktop OAuth is requested without a mobile implementation |
| `utils/provider-env` | Preserve scoped and ambient environment lookup; omit Bun's `/proc/self/environ` fallback |

Web, Node server, React server and unrelated packages retain their normal resolution. The resolver handles pnpm and source workspaces, and rejects Pi versions that have not been reviewed. No files in `node_modules` are patched.

The review used upstream commit `b45597504eeaba1f11a9920a1d1048c361ed4b8e` and the installed npm artifacts. The published `env-api-keys` mapping differs from that upstream snapshot: the native copy follows the **installed 0.87.1 artifact**, including its DeepSeek mapping and absence of the upstream `typesafe` entry. MIT attribution is retained in `LICENSE.pi`.

## Install and configure

1. Pin both Pi packages to `0.87.1`. Install the SDK-compatible `expo-crypto` package.
2. Copy the `metro/` directory and wrap your Expo Metro config **after** any other resolver wrappers:

   ```js
   const { getDefaultConfig } = require('expo/metro-config');
   const withPiNative = require('./metro/with-pi-native.cjs');

   module.exports = withPiNative(getDefaultConfig(__dirname));
   ```

3. Use an entry file that installs the secure-random bridge before importing routes that can load Pi:

   ```js
   // index.js; set package.json main to index.js
   import './src/pi/runtime';
   import 'expo-router/entry';
   ```

   Copy `src/pi/runtime.native.ts` and `src/pi/runtime.ts` alongside it. The native bridge fills only a missing `crypto.getRandomValues` using `expo-crypto`; web uses browser Web Crypto.

4. Restart Metro after changing its resolver: `npx @expo/agent-cli start --clear`.
5. Import Pi's public runtime APIs and only the provider needed by your app. Supply credentials through Pi's injectable credential/auth interfaces, rather than desktop file discovery. Use `MemorySessionRepo` initially; avoid the Node harness environment and coding-agent CLI.

The bridge was chosen after probing the actual iOS 27 / Hermes runtime: fetch, ReadableStream, text encoding, AbortController, structuredClone and BigInt were present, while global crypto was missing. Expo SDK 58 already installs its streaming fetch. This layer adds no filesystem, shell, Buffer, fetch or stream polyfills.

For the Codex provider, select SSE explicitly: its WebSocket authentication path assumes Node/Bun constructor options. A mobile OAuth implementation is separate from this compatibility layer; the desktop callback server stays outside the native dependency graph.

## Verification

```sh
node --experimental-strip-types --test tests/redirects.test.cjs tests/shims.test.mjs
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
```

The 31 compatibility tests cover exact package identity/version checks, native-only resolution, previous-resolver delegation, provider environment mappings and safe OAuth loader registration. A reachable real Pi harness/provider app was additionally bundled for iOS and Android; iOS Hermes runtime probes passed. These checks do not certify every provider or prove an authenticated model/tool run. Inspect and exercise each selected provider's import graph and runtime behavior separately.

The small starter-template web ref and hydration corrections allow the installed TypeScript/React lint checks to pass without suppressions.

## Upgrades

Before changing the Pi version guard, inspect the new installed artifacts and upstream source, compare these four modules' exports and behavior, update/remove replacements as necessary, then rerun compatibility tests, actual native bundles and device checks. Do not bypass the guard or assume web bundling proves Metro/Hermes compatibility.
