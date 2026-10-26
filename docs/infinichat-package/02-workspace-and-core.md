# Piece 2: Workspace and core

## Goal

The repository becomes a pnpm workspace in Expo's documented layout: the iOS app in `apps/mobile`, and the 35
host-neutral files in `packages/infinichat`, which the app and the server import. Nothing runs differently.

## Starts from

- Expo's monorepo guide (`https://docs.expo.dev/guides/monorepos/`, read 2026-10-26):
  - Its layout: apps in `apps/`, shared code in `packages/`, `pnpm-workspace.yaml` listing both, and the app depending
    on the package with `"workspace:*"`.
  - "Expo configures Metro automatically for monorepos" from SDK 52; no `watchFolders` or `nodeModulesPaths`
    overrides.
  - pnpm's isolated installs are supported from SDK 54 ("some native libraries may fail" with them). The app already
    installs with pnpm 10.33.0 and its default isolated layout, so nothing changes there.
  - "Duplicate React Native versions in a single monorepo are not supported", and native modules must never be
    duplicated. The package has no native code and no React dependency.
- The app's Metro already resolves packages' `exports` subpaths: it loads `@earendil-works/pi-durable/env` and
  `@earendil-works/pi-ai/utils/retry` today.
- `scripts/build-infinichat-server.mjs` and `scripts/sync-pi-daemon-assets.mjs` find their root from their own location
  (`new URL('../', import.meta.url)`), so they keep working wherever the app's folder is.
- The 48 files that import the shared set ([references](references.md#the-48-importers)).

## Builds

Two commits, each checked before the next.

### Step 1: the app moves into `apps/mobile`

```text
package.json             the workspace root: private, no dependencies of its own
pnpm-workspace.yaml      packages: ['apps/*', 'packages/*'], and onlyBuiltDependencies from package.json's pnpm field
pnpm-lock.yaml           stays at the root: one lockfile for the workspace
apps/mobile/             git mv: src/, assets/, modules/, babel-plugins/, server/, scripts/, app.json, package.json,
                         tsconfig.json, babel.config.js, metro.config.js, eslint.config.js
docs/, AGENTS.md, CLAUDE.md, README.md, PLAN.md, pi-harness-agent-guide.html, LICENSE, LICENSE.pi,
.gitignore, .gitattributes, .vscode/, .claude/   stay at the root
```

- `.gitignore` anchors `/ios` and `/android` at the root (lines 41-42). They become `/apps/mobile/ios` and
  `/apps/mobile/android`. The root's generated `ios/` (ignored, Continuous Native Generation) is no longer used;
  `prebuild` makes a new one in `apps/mobile`.
- `app.json` moves unchanged, so the app keeps its bundle identifier: the build installs over the existing app, and its
  data stays.
- `metro.config.js`'s block list for `docs/infinichat` matches a path segment, so it still applies. In a monorepo Metro
  watches the workspace root, where `docs/` stays.
- Expo, EAS and `@expo/agent-cli` commands run from `apps/mobile` from now on.
- AGENTS.md's paths (`src/app/`, `.agents/skills/…`) become relative to `apps/mobile`. Its "Expo project" and
  "Package skills" sections come from `@expo/agent-cli`; check where `skills:sync` writes once the project is in
  `apps/mobile`, and keep one AGENTS.md where agents read it.

### Step 2: the package

#### `packages/infinichat/package.json`

```json
{
  "name": "@pi-agent/infinichat",
  "private": true,
  "exports": { "./*": "./src/*.ts" },
  "scripts": { "lint": "eslint ." },
  "peerDependencies": {
    "@earendil-works/chord": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-durable": "1.4.0"
  },
  "devDependencies": { "eslint": "…", "eslint-config-expo": "…" }
}
```

- **The name** follows the repository's package, `pi-agent`.
- **TypeScript source, no build step.** Metro and esbuild both compile it.
- **pi packages as exact peer dependencies,** so each consumer supplies one copy. The phone and the server must run the
  same pi-durable: its SQLite migrations are one-way, and the server build reads pi's versions from the app's own
  dependencies (`INFINICHAT_PI`). Check with `pnpm why @earendil-works/pi-durable` that one version is installed.
- **The `./*` wildcard keeps the moved layout importable,** for example
  `@pi-agent/infinichat/pi/infinichat-service`. Metro's support for subpath patterns is the first thing to confirm,
  with a bundle, before moving anything else.
- **Lint of its own,** with the app's ESLint and `eslint-config-expo` versions. The app's `expo lint` covers only
  `apps/mobile`: ESLint ignores files outside its base path.
- **No `tsconfig.json` of its own.** pnpm links the package by its real path, so the app's typecheck checks the
  package files the app imports, and the server's typecheck covers what it bundles.

`apps/mobile/package.json` gains `"@pi-agent/infinichat": "workspace:*"`. Add it through `npx @expo/agent-cli install`
if it accepts the `workspace:` protocol; otherwise edit `package.json` and run `pnpm install`. Record which one worked.

#### The move

`git mv` each of the 35 files ([list](references.md#the-shared-set)) from `apps/mobile/src/` to the same relative path
under `packages/infinichat/src/`. Their imports of each other stay byte-identical, because `../chat/types` from
`src/pi/…` still points at `src/chat/types`.

Then rewrite the 48 importers to the package path:

```ts
// before, in apps/mobile/src/chat/chat-provider.tsx
import { InfiniChatService } from '../pi/infinichat-service';
// after
import { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';
```

None of the moved files use the app's `@/` alias, so nothing inside the package needs it.

#### The lint guard

`packages/infinichat/eslint.config.js`:

```js
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    files: ['src/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { group: ['node:*'], message: 'Node APIs belong in src/node (piece 5).' },
        { group: ['expo', 'expo-*', 'expo/*', '@expo/*', 'react', 'react-native', 'react-native-*', '@osuki-dev/*',
          '@strawberrytech/*', 'just-bash', 'just-bash/*', 'ws', 'buffer'], message: 'Host APIs stay in the apps.' },
      ] }],
    },
  },
]);
```

pnpm's isolation alone doesn't keep the package host-neutral. Expo's monorepo configuration gives Metro the app's
`node_modules` as a lookup path too, so a stray `expo-*` import from the package would still bundle. And a compiler
setting can't do it either: the 35 files typecheck with `types: []` and only the ES2024 library, but only because
pi-ai's bundled provider SDK types (`@anthropic-ai/sdk`) import `undici-types`, which pulls in Node's types
([references](references.md#a-typecheck-without-host-types)). The lint rule is the guard.

## Ownership and lifetime

Unchanged.

## Deviations (need approval)

None. The layout is the one Expo's guide shows.

## Size

Step 1: about 180 tracked files moved unchanged, plus `pnpm-workspace.yaml`, the root `package.json`, two `.gitignore`
lines and AGENTS.md's paths. Step 2: 35 files moved unchanged, 48 importers' import lines rewritten, and the
package's `package.json` and `eslint.config.js`.

## Checks

After step 1:
- From `apps/mobile`: an iOS bundle (`npx @expo/agent-cli smoke --ios`, or an export), `npx @expo/agent-cli lint`,
  `npx @expo/agent-cli typecheck`, `pnpm exec tsc -p server`.
- Rebuild the server asset in the main checkout's `apps/mobile`, then run `--check`. The bundle's hash changes, because
  its module paths are relative to the app's folder.
- An iPhone Release build from `apps/mobile` installs over the existing app, and InfiniChat shows its conversation.

After step 2:
- An iOS bundle that resolves the wildcard subpath first.
- The app's lint, typecheck and server typecheck, and `pnpm --filter @pi-agent/infinichat lint`.
- Add a banned import to a package file by hand, confirm the package's lint fails, and remove it.
- Rebuild the server asset, then run `--check`.
- On the iPhone Release install, with the database backed up:
  - InfiniChat on the phone: send, Stop, settings, Scheduled tasks.
  - Choose vikash-system: the phone reinstalls the server (new bundle), the transcript appears, and a message gets an
    answer.
  - One move each way, and a summary is built after the move.

## Not in this piece

The `Link` split (piece 3), install and move (piece 4), and the Node implementations (piece 5).
