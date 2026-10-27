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

## As built

Built at `8761638` (step 1) and the commit after it (step 2), from `ea1e0b6`, with pi 1.4.0 (pi-durable, pi-ai, chord
and pi-env; the latest on npm on 2026-10-26), Expo 58.0.17, React Native 0.88.0, pnpm 10.33.0 and
`@expo/agent-cli` 1.0.21. Expo's monorepo guide was read again the same day (modified 2026-10-16). Step 1 moved 181
tracked files; step 2 moved the 35 files byte for byte (`git` records 35 exact renames) and rewrote 51 importers: 40 in
the app and 11 in `server/`, the set piece 1's "As built" predicted.

What differs from the plan:

- **Metro doesn't watch the workspace root, so the `docs/infinichat` exclusions are gone.** `@expo/metro-config`
  58.0.16 (`build/getWatchFolders.js`) watches the root's `node_modules` and each workspace package; the app's config
  prints `[<root>/node_modules, <root>/apps/mobile]`, with `packages/infinichat` added in step 2. `docs/` is never
  crawled, so the block list entry in `metro.config.js` matched nothing, and the `docs` entries in `tsconfig.json`'s
  `exclude` and `eslint.config.js`'s `ignores` pointed outside `apps/mobile`. All three were removed in step 1, and
  AGENTS.md says why Metro, the typecheck and lint never reach the guide.
- **`.gitattributes` follows the server asset.** A pattern with a slash is anchored where the file sits, so
  `assets/infinichat-server/server.bin binary` became `apps/mobile/assets/…`.
- **The lockfile keeps its resolutions.** A plain `pnpm install` re-resolved the moved importer: `babel-preset-expo`
  went from 58.0.13 to 58.0.19, and in step 2 protobufjs's `@types/node` from 26.6.5 to 22.20.5. Instead the importer
  key was renamed from `.` to `apps/mobile` by hand (step 1) and the new importer entries were kept with protobufjs's
  old resolution (step 2), and `pnpm install --frozen-lockfile` accepted both. The lockfile diff is only the importer
  key in step 1 and 22 added lines in step 2. A later non-frozen install may make those two dedupes.
- **`npx @expo/agent-cli install` refuses `workspace:*`** (`npm-package-arg`: `Unsupported URL Type "workspace:"`), so
  `apps/mobile/package.json` was edited and `pnpm install` run.
- **pi's versions come from a pnpm catalog, not two exact pins.** pnpm installs a package's peer dependencies as its
  own (`autoInstallPeers`, on by default), so `packages/infinichat/node_modules/@earendil-works/*` are links of their
  own, and Metro and esbuild try the importing file's nearest `node_modules` first. Two pins agree only while both
  manifests are edited together: a pi upgrade in `apps/mobile/package.json` alone would put two copies of pi-durable,
  pi-ai and chord in the phone's bundle and the server's. `pnpm-workspace.yaml` now has a `catalog` with the three
  versions, and the app's dependencies and the package's peer dependencies name them as `catalog:`, which pnpm
  10.33.0 accepts in `peerDependencies` (`validatePeerDependencies`). AGENTS.md's pi-upgrade rule says to upgrade
  there. The lockfile gains a `catalogs` section and six `catalog:` specifiers; protobufjs's resolution was kept again.
  pi-env stays an exact pin in the app's development dependencies until piece 5 makes it the package's peer and adds
  it to the catalog. It depends on chord and pi-durable at exact versions (pi-env 1.4.0's `dependencies`), so a
  catalog upgrade without it would give the server bundle a second pi-durable; the AGENTS.md rule moves its pin in the
  same step.
- **The guard names Node's built-in modules.** A `node:*` group misses bare specifiers (`fs`, `fs/promises`,
  `crypto`), which typecheck because Node's types are in the program. The Node group adds `builtinModules` from
  `node:module`, each with a leading slash: a group is a gitignore pattern (`ignore` 5.3.2 in ESLint 9.39.5), so a bare
  `events` would also match `./events` and `some-package/events`. The host group adds `@shopify/*` and
  `torch-image-playground`, the app's two native dependencies it missed, and drops `buffer`, which the Node list
  names, so a `buffer` import reports once.
- **The guard names pi's host adapters.** pi keeps them at subpaths of the packages the package may import, named in
  their `exports` maps: pi-durable's `env/node`, `images/node`, `storage/jsonl/node` and `storage/sqlite/node`,
  chord's `node` and `sqlite/node`, the `cloudflare` variants of both, pi-durable's `storage/indexeddb` and pi-ai's
  `bun-oauth`. They resolve from the package's own peers, so they typecheck, and the Node ones import Node's modules
  (pi-durable `dist/env/node.js:1-7`; chord `dist/sqlite/node.js`, `node:sqlite`; the OAuth flows `bun-oauth.js`
  loads, `node:http` and `node:crypto`), which the app's Metro config doesn't map. The Node group adds
  `@earendil-works/**/node`, `@earendil-works/pi-ai/bun-oauth` and `@earendil-works/pi-env`, whose only entry point
  re-exports modules that import `node:*`; the host group adds `@earendil-works/**/cloudflare` and
  `@earendil-works/pi-durable/storage/indexeddb`. The review proposed `bun-oauth` for the host group; it is in the Node
  group because it is Node code, which a file under `src/node` may use.
- **One AGENTS.md, maintained by hand.** `@expo/agent-cli` keeps its block in `AGENTS.md` relative to the Expo project,
  and `skills:sync --dry-run` from `apps/mobile` plans `apps/mobile/.agents/skills/expo-sqlite` for Codex only. Agents
  read the root AGENTS.md, so it stays the only one, and nothing was re-synced: the `.agents/skills/expo-sqlite` link
  its Package skills table uses still resolves into the root `node_modules/.pnpm`. `.claude/skills/expo-sqlite` was
  already dangling before this piece (its expo-sqlite 58.0.9 target was pruned on 2026-10-20) and is untouched; both
  links are git-ignored. AGENTS.md now says where the app is, that app paths are relative to it, and where commands
  run.
- **README.md** says the app is in `apps/mobile`, adds `cd apps/mobile` to the run commands, and its four file links
  point there.
- **The package's lint prints a warning** that eslint-plugin-react can't detect React. eslint-config-expo sets
  `react.version: "detect"`, and the package has no React dependency, so the warning stays rather than a React setting
  the package doesn't need.
- **The eslint config has comments** saying why the package lints itself, why the guard exists, why the Node names
  are anchored and why pi's host subpaths are named.

Choices:

- The root `package.json` takes the shape of Expo's guide: `pi-agent-monorepo`, private, version 0.0.0. The app keeps
  the name `pi-agent`.
- Ignored, generated app state moved with the app: `.expo/` (typed routes and agent-cli state), `expo-env.d.ts` and
  `dist/`. The root's generated `ios/` (678 MB, ignored) would have shown as untracked once `.gitignore` anchored
  `/apps/mobile/ios`, so it was set aside, not deleted, at `~/pi-react-native/backup-2026-10-26-root-ios/ios`. Its
  project carried the signing team `BMNS2Z2BU9`; the first Release build from `apps/mobile` prebuilds a new one.
- A rewritten import joins the file's package group, sorted by specifier, as the files already group packages before
  local paths; seven lines that grew past 120 characters use the repository's multi-line import form. The package's
  modules have no top-level effects beyond definitions (chord's `remote`, document and schema definitions), so
  evaluating them earlier in a file changes nothing. The server bundle has the same lines as before, with paths
  `../../packages/infinichat/src/…`, and one module in a new place: the Photon WASM constant now follows
  `device-tools`.
- Metro's subpath pattern was confirmed before the move: a temporary `src/wildcard-probe.ts` imported from the root
  layout as `@pi-agent/infinichat/wildcard-probe` bundled (its string was in the export), then both were removed.

Checks:

- Step 1, from `apps/mobile`: an iOS export (`npx expo export --platform ios`), 12,596,463 bytes of bytecode;
  `npx @expo/agent-cli lint` (131 files, no problems); `npx @expo/agent-cli typecheck` (no type errors);
  `pnpm exec tsc -p server` (no errors). The server asset was rebuilt here and passes `--check`: 8,351,609 bytes,
  SHA-256 `023b75a2…bfe1c2`, identical to the last one once `../../` is dropped from its module paths.
- Step 2: the wildcard probe above; an iOS export with source maps listing all 35 package files under
  `/packages/infinichat/src/` and one store directory each for pi-durable, pi-ai, chord and pi-telemetry, and an export
  without them at 12,596,469 bytes; the app's lint and typecheck and the server typecheck, all clean, with
  `tsc --listFiles` showing the 35 files in both the app's and the server's programs;
  `pnpm --filter @pi-agent/infinichat lint` (36 files, no errors). Adding `expo-crypto`, `node:fs/promises` and
  `buffer` imports to `src/pi/model-auth.ts` failed the package's lint with three `no-restricted-imports` errors, and
  removing them passed it again. The server asset, rebuilt here, passes `--check`: 8,352,831 bytes, SHA-256
  `668a9eec…3cecff`, with the same lines as step 1's after the path change.
- After the review fixes: the app's lint (96 files), typecheck and server typecheck and the package's lint, all clean;
  an iOS export with the same file name and size as one from the commit before, differing only in the bundler's
  temporary entry path (`/var/folders/…/expo-bundler-…/index.js`); the server asset, unchanged because nothing the
  server imports changed, passes `--check`. The guard probe with `fs/promises`, `crypto`, `path`, `child_process`,
  `timers/promises`, `node:fs`, `buffer`, `@shopify/flash-list`, `torch-image-playground`, `expo-crypto` and `ws`
  failed with eleven `no-restricted-imports` errors, one each, while `./events` and `../chat/util` drew none.
- After the second review round: the app's lint (96 files), typecheck and server typecheck and the package's lint (36
  files), all clean; an iOS export with the same file name and a byte's difference from one at the commit before,
  again only the bundler's temporary entry path; the server asset, unchanged because nothing the server imports
  changed, passes `--check`. The guard probe (ESLint's `lintText` on a virtual `src/pi/probe.ts`) restricts each of
  pi's eleven host subpaths and pi-env above, one error each, alongside `fs/promises`, `node:fs`, `buffer`,
  `expo-crypto`, `@shopify/flash-list` and `ws`, and allows `@earendil-works/pi-durable`, its `env`, `images`,
  `storage/sqlite`, `storage/jsonl`, `storage/memory` and `tools`, `chord`, `chord/context`, `chord/sqlite`, `pi-ai`,
  `pi-ai/utils/retry`, `pi-ai/providers/model-schema` and `pi-ai/providers/anthropic`, `./events` and `../chat/util`.
- `pnpm why -r @earendil-works/pi-durable` finds one version, and the package's auto-installed peers link to the same
  store directories as the app's. With the catalog, setting chord to 1.3.0 there and running
  `pnpm install --lockfile-only` moved both importers to 1.3.0; the two files were then restored.
- `pnpm ignored-builds` can't answer on this checkout: from the root and from `apps/mobile` it prints "Cannot identify
  as no node_modules found", because pnpm 10.33.0 reads an `ignoredBuilds` key from `node_modules/.modules.yaml` and
  this install wrote none. Other evidence shows enriched-markdown's build is allowed: it isn't in `.modules.yaml`'s
  `skipped` list, `pnpm config get only-built-dependencies` prints it, so `onlyBuiltDependencies` is read from
  `pnpm-workspace.yaml`, and `pnpm rebuild react-native-enriched-markdown` runs its postinstall.
- Autolinking from `apps/mobile` resolves 42 Expo modules, including `pi-oauth-callback` and
  `torch-image-playground`, and the 12 React Native packages, among them react-native-ssh, nitro-zlib and
  enriched-markdown.
- `npx @expo/agent-cli doctor`: 19 of 20; the failing check lists Expo patch releases newer than the installed ones,
  unrelated to this piece.

Unverified: nothing ran on a device, and `smoke --ios` wasn't run (the exports stand in for it). The first Release
build from `apps/mobile`, which prebuilds `ios/` there and has to pick a signing team, and every device check above
are left to the owner's iPhone. The new server bundle means the phone reinstalls the server on each machine at its
next connect. A fresh install running enriched-markdown's postinstall from nothing wasn't tried.
