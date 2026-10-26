# Piece 2: Workspace and core

## Goal

The 35 host-neutral files live in one workspace package, `packages/infinichat`, and the iOS app and the server import
them from there. Their contents don't change, and nothing runs differently.

## Starts from

- Expo's monorepo guide (`https://docs.expo.dev/guides/monorepos/`, read 2026-10-26):
  - "Expo configures Metro automatically for monorepos" from SDK 52; no `watchFolders` or `nodeModulesPaths`
    overrides.
  - pnpm's isolated installs are supported from SDK 54 ("some native libraries may fail" with them). The app already
    installs with pnpm 10.33.0 and its default isolated layout.
  - The layout it shows: apps in `apps/`, shared code in `packages/`, `pnpm-workspace.yaml` listing both, and the app
    depending on the package with `"workspace:*"`.
  - "Duplicate React Native versions in a single monorepo are not supported", and native modules must never be
    duplicated. The package has no native code and no React dependency.
- The app's Metro already resolves packages' `exports` subpaths: it loads `@earendil-works/pi-durable/env` and
  `@earendil-works/pi-ai/utils/retry` today.
- The server bundle: esbuild from `server/main.ts` with `absWorkingDir` set to the repository root
  (`scripts/build-infinichat-server.mjs`). esbuild follows workspace symlinks.
- The 48 files that import the shared set ([references](references.md#the-48-importers)).

## Builds

### Layout

Keep the iOS app at the repository root, and add the package beside it:

```text
pnpm-workspace.yaml          packages: ['packages/*']
package.json                 the iOS app, now also "@pi-agent/infinichat": "workspace:*"
packages/infinichat/
  package.json
  src/chat/…                 the moved src/chat files
  src/pi/…                   the moved src/pi files
server/                      unchanged location
```

Moving the app into `apps/ios` is the guide's layout, but it also touches EAS, `modules/`, `babel-plugins/`, the
scripts and every config file. Do that as its own step when the Mac app starts.

With the app at the root, the root `node_modules` holds the app's dependencies, so a stray `expo-*` import in the
package would still resolve. The lint guard below is what keeps the package host-neutral until the app moves into
`apps/`, where pnpm's isolation catches it as well.

pnpm 10 reads settings such as `onlyBuiltDependencies` from the root `package.json`'s `pnpm` field. Check that
`react-native-enriched-markdown`'s postinstall still runs once a `pnpm-workspace.yaml` exists; if not, move that
setting into the workspace file.

### `packages/infinichat/package.json`

```json
{
  "name": "@pi-agent/infinichat",
  "private": true,
  "exports": { "./*": "./src/*.ts" },
  "peerDependencies": {
    "@earendil-works/chord": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-durable": "1.4.0"
  }
}
```

- **TypeScript source, no build step.** Metro and esbuild both compile it.
- **pi packages as exact peer dependencies,** so each consumer supplies one copy. The phone and the server must run the
  same pi-durable: its SQLite migrations are one-way, and the server build reads pi's versions from the app's own
  dependencies (`INFINICHAT_PI`). Check with `pnpm why @earendil-works/pi-durable` that one version is installed.
- **The `./*` wildcard keeps the moved layout importable,** for example
  `@pi-agent/infinichat/pi/infinichat-service`. Metro's support for subpath patterns is the first thing to confirm,
  with a bundle, before moving anything else.
- No `tsconfig.json` of its own: the app's typecheck includes `packages/**` through its `**/*.ts` include, and the
  server's covers what it bundles.

Add the dependency through `npx @expo/agent-cli install` if it accepts the `workspace:` protocol; otherwise add it to
`package.json` and run `pnpm install`. Record which one worked.

### The move

`git mv` each of the 35 files ([list](references.md#the-shared-set)) to the same relative path under
`packages/infinichat/src/`. Their imports of each other stay byte-identical, because `../chat/types` from
`src/pi/…` still points at `src/chat/types`.

Then rewrite the 48 importers to the package path:

```ts
// before, in src/chat/chat-provider.tsx
import { InfiniChatService } from '../pi/infinichat-service';
// after
import { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';
```

None of the moved files use the app's `@/` alias, so nothing inside the package needs it.

A tidier layout for the package's own folders can follow in a separate commit. Keep this one a move.

### The lint guard

Add a block to `eslint.config.js`:

```js
{
  files: ['packages/infinichat/src/**'],
  rules: {
    'no-restricted-imports': ['error', { patterns: [
      { group: ['node:*'], message: 'Node APIs belong in packages/infinichat/src/node (piece 5).' },
      { group: ['expo', 'expo-*', 'expo/*', '@expo/*', 'react', 'react-native', 'react-native-*', '@osuki-dev/*',
        '@strawberrytech/*', 'just-bash', 'just-bash/*', 'ws', 'buffer'], message: 'Host APIs stay in the apps.' },
    ] }],
  },
},
```

A compiler setting can't do this job. The 35 files typecheck with `types: []` and only the ES2024 library, but only
because pi-ai's bundled provider SDK types (`@anthropic-ai/sdk`) import `undici-types`, which pulls in Node's types
([references](references.md#a-typecheck-without-host-types)).

## Ownership and lifetime

Unchanged.

## Deviations (need approval)

- The iOS app stays at the root, not in `apps/` as Expo's guide shows (see Layout).

## Size

35 files moved unchanged, 48 importers' import lines rewritten, and three small files (`pnpm-workspace.yaml`, the
package's `package.json`, the lint block).

## Checks

- An iOS bundle that resolves the wildcard subpath first (`npx @expo/agent-cli smoke --ios`, or an export).
- `npx @expo/agent-cli lint`, `npx @expo/agent-cli typecheck`, `pnpm exec tsc -p server`.
- Add a banned import to a package file by hand, confirm lint fails, and remove it.
- Rebuild the server asset in the main checkout, then run `--check`. The bundle's hash changes.
- On the iPhone Release install, with the database backed up:
  - InfiniChat on the phone: send, Stop, settings, Scheduled tasks.
  - Choose vikash-system: the phone reinstalls the server (new bundle), the transcript appears, and a message gets an
    answer.
  - One move each way, and a summary is built after the move.

## Not in this piece

The `Link` split (piece 3), install and move (piece 4), and the Node implementations (piece 5).
