This is an Expo/React Native app for iOS. Prioritize iOS-native patterns and the components Expo provides.

The repository is a pnpm workspace in Expo's monorepo layout, and the app, with its `server/` and `scripts/`, is in
`apps/mobile`. App paths in this file (`src/app/`, `app.json`, `package.json`, `ios/`) are relative to `apps/mobile`.
Install with `pnpm install` from the root; run Expo, EAS and `@expo/agent-cli` commands from `apps/mobile`.
`@expo/agent-cli` writes its AGENTS.md block and skill links relative to the Expo project, but agents read this
AGENTS.md at the root, so keep it the only one and its block up to date here.

InfiniChat, the OptChat-on-pi-durable tab, has its implementation guide at `docs/infinichat/README.md`. The guide's
TypeScript, tests and examples are reference material with their own `package.json`. It is outside the workspace's
apps and packages, so Metro, the typecheck and lint never reach it.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx @expo/agent-cli install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx @expo/agent-cli start              # start the dev server
npx @expo/agent-cli lint               # lint
npx tsc --noEmit            # typecheck
npx @expo/agent-cli doctor             # diagnose dependency and config issues
npx @expo/agent-cli install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Coding rules

- Never use `any`.
- Never use type casts (`as X`, `as unknown as X`) or non-null assertions (`x!`) without explicit permission from the owner. `as const` is fine. Prefer typed SDK APIs. A cast that seems necessary usually means a design seam is wrong (for example, rebuilding an SDK-issued id from a string instead of looking it up among the records the SDK returned).
- Approved exception: reading pi-durable's built-in documents from `ConversationView.docs` by kind with the SDK's own types (`docs["pi.live"] as LiveState`, likewise `InboxState` and `AgentState`), in one helper, exactly as pi's v1.1.0 example `packages/durable/test/examples/21-late-join.ts` does. Don't replace it with hand-written decoders or shadow types.
- Before inventing a pattern for a pi-durable, pi-ai or pi-env integration, find the matching upstream example or source at the installed version tag (github.com/earendil-works/pi, `packages/*/test/examples`, tag `v<installed version>`) and follow it, or state why none applies.
- Idiomatic first; no speculative performance work. Use Expo and pi-durable the way their docs and examples do and assume it is fast enough. Don't add caches, batching, budgets or other optimization layers without a measured problem on a real device.
- No app-added limits by default; use library defaults. Never construct stress or adversarial scenarios (huge files, runaway loops, enormous outputs) to justify a limit or an optimization. Only ordinary, realistic use counts as evidence.
- Upstream decides how; the product decides what. A missing upstream feature is never a reason to drop a product feature: build it in the simplest way consistent with upstream's mechanics. Any deviation from upstream's pattern needs the owner's approval.
- Don't re-create what pi-durable, pi-ai, chord, just-bash or Expo already provide.
- Expo packages should just work: no app-written polyfills and no patches to third-party bundles. If something is missing, report it instead of patching around it.
- Never mint SDK-branded ids; look them up among the records the SDK returned.
- Deletion is the default: no mechanism or API without a production caller or a stated product requirement. No production code that exists only for tests.
- The app is unreleased: no backwards compatibility with existing on-device data. Don't preserve old chats, ids, document shapes or stored selections, and don't write compatibility or migration code. If old data breaks the app after a change, the fix is clearing app data; say so in your report.
- Stay on the latest pi releases: check npm before starting work, and upgrade as its own step. pi-durable, pi-ai,
  chord and pi-env take their versions from the `catalog` in `pnpm-workspace.yaml`, which `packages/infinichat`'s
  peer dependencies share, so upgrade all four there together (pi-env depends on chord and pi-durable at exact
  versions); `pnpm why -r @earendil-works/pi-durable` then finds one version.
- Keep lines under about 120 characters, no multi-statement one-liners, and comments that explain why, not what.
- Design before code: for non-trivial work, propose which upstream example you start from, any deviations, and the rough size compared with upstream's equivalent, and get approval before implementing. Size is a signal: a feature several times larger than upstream's equivalent means the design is wrong.

## Upstream contracts and integration review

- Before implementing or reviewing a dependency integration, inspect the installed package's public contracts and the current canonical upstream example. Record the package version and source revision used; an existing app abstraction or test is not evidence of the upstream contract.
- State who creates, borrows, cancels and closes each resource, including its lifetime across calls and application shutdown. Distinguish operation cancellation and caller-owned handles from shared-owner cleanup.
- Choose the smallest integration that follows the upstream ownership and usage pattern. Any additional policy, reset boundary, counter or ownership layer needs a concrete product requirement or demonstrated correctness need. Existing code and tests are not requirements: remove unnecessary behavior rather than preserving it by default. Keep operation cancellation separate from filesystem lifetime.
- Implementers don't write tests. Verify user-visible behavior on an iPhone or the iOS simulator, including relevant
  sharing, cancellation and shutdown boundaries.
- Review the final implementation against those contracts and update affected guidance. Report source assessment,
  device checks and unverified behavior separately.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a
  development build: `npx @expo/agent-cli run:ios` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

<!-- BEGIN EXPO AGENT CLI MANAGED BLOCK -->
<!-- Generated by `npx @expo/agent-cli agents:setup`. Everything inside the markers is overwritten on the next run. -->

## Expo project

- Project: pi-agent
- SDK: 58.0.6
- Native: CNG (no native directories; they are generated by `npx expo prebuild`)
- Expo Go: not compatible (7 reasons; needs a development build, run `npx @expo/agent-cli status --json` for the details)
- Dev client: `expo-dev-client` is installed

## Commands

For the operations listed below, use `@expo/agent-cli` in place of the equivalent commands elsewhere in this file or in loaded skills. Package installation still uses Expo’s SDK-compatible version resolution. Use `bunx` instead of `npx` when `bun.lock` is present.

Most commands take `--json` for a machine-readable report.

- `npx @expo/agent-cli status` — where the project is right now, and what would happen next
- `npx @expo/agent-cli status --json` — the same report as one object, with the raw project probe under `probe`
- `npx @expo/agent-cli status --explain` — the deep dive: which sources changed, whether an update can ship over the air, and whether EAS already has a build for this fingerprint
- `npx @expo/agent-cli status --assert js-only` — a gate on what a change costs: exit 20 when it costs more than the class named, 22 when nothing could be measured, 0 otherwise
- `npx @expo/agent-cli dev --ios` — get the app onto that platform's device: it prints the plan, then runs it. The platform flag (--ios, --android, --web) is required; add --plan to print the steps without running them
- `npx @expo/agent-cli start` — `expo start` and nothing else: a dev server no planning may touch
- `npx @expo/agent-cli install <pkg>` — install a package and report what it changes natively
- `npx @expo/agent-cli install --fix` — fix incompatible package versions using Expo's SDK-compatible version resolution
- `npx @expo/agent-cli lint` — run the project's Expo lint command
- `npx @expo/agent-cli doctor` — diagnose dependency and configuration issues with expo-doctor
- `npx @expo/agent-cli typecheck` — run the TypeScript compiler of this project as a gate: exit 20 with the diagnostics, exit 0 when there are none. A bundle that builds and an app that does not throw do not cover this.
- `npx @expo/agent-cli runtime:eval <js>` — evaluate JavaScript in the running app
- `npx @expo/agent-cli runtime:errors` — collect the runtime errors of the running app
- `npx @expo/agent-cli navigate <route>` — open a route as a deep link on a device
- `npx @expo/agent-cli runtime:tree` — what is on the screen of the running app, by testID
- `npx @expo/agent-cli runtime:tap <testID>` — tap an element; `--verify` reports what changed
- `npx @expo/agent-cli runtime:type <text> --testID <id>` — type into an input
- `npx @expo/agent-cli skills:list` — the agent skills the installed packages ship
- `npx @expo/agent-cli new <dir>` / `npx @expo/agent-cli deploy` — create a project headlessly / deploy web and native
- `npx @expo/agent-cli smoke --ios` — the whole gate in one command: the dev server bundles, the app is up, and nothing threw

## Expo skills

For Expo or EAS work, start with the `expo-overview` skill when it is available in your agent’s skill list. It routes your goal to the relevant Expo or EAS skill. Then read any matching package skills listed below for guidance specific to the installed packages.

<!-- BEGIN EXPO PACKAGE SKILLS -->
## Package skills

Before using or modifying a package listed below, read its relevant skill for package-specific guidance. Each link for a row opens the same skill.

| Package | Skill | Read |
| --- | --- | --- |
| expo-sqlite | expo-sqlite | [.agents/skills/expo-sqlite/SKILL.md](.agents/skills/expo-sqlite/SKILL.md) |

Run `npx @expo/agent-cli skills:sync` after changing dependencies to refresh this index. Run `npx @expo/agent-cli skills:list` to see available package skills.
<!-- END EXPO PACKAGE SKILLS -->

Commands end with a `Suggested next:` section — suggested follow-up commands, not required steps. Run one only when it serves your current goal.
<!-- END EXPO AGENT CLI MANAGED BLOCK -->
