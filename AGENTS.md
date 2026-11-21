This is an Expo/React Native app for iOS. Prioritize iOS-native patterns and the components Expo provides.

The repository is a pnpm workspace in Expo's monorepo layout: the iOS app is in `apps/mobile`, the Mac app in
`apps/mac`, the shared InfiniChat code in `packages/infinichat`, and the server machines run, with its build and
release scripts, generated daemon manifest and the pi-env daemons both apps ship, in `packages/infinichat-server`. The
server is published as `server/v<version>` GitHub releases (`pnpm release` there, before the apps that need it) and
updates itself; the apps only set one up on a machine that has none. For server plugin and MCP work, read
`docs/server-plugins.md`: the server, both apps and the shared client are on Chord v2 (the package since chord 1.5.1,
its design in chord's `docs/design.md`); `/reload-plugins` rebuilds and reloads the user's plugins and applies
`mcp.json` again; InfiniChat's own plugin and the tools plugin (code mode and MCP) change only by a release, which
restarts the service. A machine's agents write plugins and add MCP servers themselves when the user asks: a prompt
section (`src/extending.ts`) names the guide a release ships (`packages/infinichat-server/docs/extending.md`, the
reference for a plugin's layout and for `mcp.json`) and their `reload_plugins` tool. InfiniChat's design, what of
UniiChat's each pi-durable and Chord mechanism carries, where it differs, and how the conversation is stored and moved
between devices (a Chord store, and Chord's session sync through a folder on a machine), is in
`docs/infinichat-design.md`: read it before work on the agent core or a move. On a machine, Claude is offered
through its Claude Code login (pi-claude-code, a pinned git dependency of the server) beside pi-ai's Anthropic
provider, which takes an API key. The phone's SSH library,
`@automatalabs/react-native-ssh`, is the owner's fork of `@osuki-dev/react-native-ssh` in
`packages/react-native-ssh` (Rust engine, C FFI, Nitro module); `pnpm install` builds its `lib/`, and its iOS
archives are built there by `bash scripts/build-rust-ios.sh` before an iOS build, neither committed; an EAS build
runs that itself (`scripts/eas-build-pre-install.sh`, the app's `eas-build-pre-install` hook). App paths
in this file (`src/app/`, `app.json`, `package.json`, `ios/`) are relative to `apps/mobile`.
Install with `pnpm install` from the root; run Expo, EAS and `@expo/agent-cli` commands from `apps/mobile`.
`@expo/agent-cli` writes its AGENTS.md block and skill links relative to the Expo project, but agents read this
AGENTS.md at the root, so keep it the only one and its block up to date here.

The tests of InfiniChat's agent core (`packages/infinichat/src/pi/infinichat`) are in `packages/infinichat/test`. Run
them with `bun test test` from `packages/infinichat`.

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
- Approved exception: reading pi-durable's built-in documents from `ConversationView.docs` by kind with the SDK's own types (`docs["pi.live"] as LiveState`, likewise `InboxState` and `AgentState`), in one helper, exactly as pi's v1.5.0 example `packages/durable/test/examples/20-late-join.ts` does. Don't replace it with hand-written decoders or shadow types.
- Before inventing a pattern for a pi-durable, pi-ai or pi-env integration, find the matching upstream example or source at the installed version tag (github.com/earendil-works/pi, `packages/*/test/examples`, tag `v<installed version>`) and follow it, or state why none applies.
- Idiomatic first; no speculative performance work. Use Expo and pi-durable the way their docs and examples do and assume it is fast enough. Don't add caches, batching, budgets or other optimization layers without a measured problem on a real device.
- No app-added limits by default; use library defaults. Never construct stress or adversarial scenarios (huge files, runaway loops, enormous outputs) to justify a limit or an optimization. Only ordinary, realistic use counts as evidence.
- Upstream decides how; the product decides what. A missing upstream feature is never a reason to drop a product feature: build it in the simplest way consistent with upstream's mechanics. Any deviation from upstream's pattern needs the owner's approval.
- Don't re-create what pi-durable, pi-ai, chord, just-bash or Expo already provide.
- Expo packages should just work: no app-written polyfills and no patches to third-party bundles. If something is missing, report it instead of patching around it. One exception, the owner's (2026-11-20): the compression streams Chord's session sync needs on Hermes come from a library (`src/pi/compression-streams.ts`).
- Never mint SDK-branded ids; look them up among the records the SDK returned.
- Deletion is the default: no mechanism or API without a production caller or a stated product requirement. No production code that exists only for tests.
- The app is unreleased: no backwards compatibility with existing on-device data. Don't preserve old chats, ids, document shapes or stored selections, and don't write compatibility or migration code. If old data breaks the app after a change, the fix is clearing app data; say so in your report. The owner's exceptions: the conversation's upgrade to the tree of agents (2026-11-18) and its conversion to a Chord store (`infinichat-convert.ts`, 2026-11-20).
- Stay on the latest pi releases: check npm before starting work, and upgrade as its own step. pi-durable, pi-ai,
  chord, pi-env, pi-codemode, pi-mcp and pi-schema take their versions from the `catalog` in `pnpm-workspace.yaml`,
  which `packages/infinichat`'s peer dependencies share, so upgrade all seven there together (pi-env depends on chord
  and pi-durable at exact versions, and they on pi-schema); `pnpm why -r @earendil-works/pi-durable` then finds one
  version. The server's `runtime/package.json` pins the same versions (`scripts/build.mjs --check`), and
  `scripts/sync-daemons.mjs` pins pi-env's daemon to the same release. pnpm leaves the versions before in
  `node_modules/.pnpm`, and the dev server's Metro keeps resolving the packages to them from its file map, so the
  app runs the old packages under the new code and fails as it loads (`defineSignal` undefined, 2026-11-20). An
  export resolves them anew. Before the first `@expo/agent-cli dev` after an upgrade, remove `metro-file-map-*` from
  the temp folder, which fixed it (`npx expo start --clear` is Expo's own reset of Metro's cache).
- An app and a server bind by `infinichat.remote` and `infinichat.mcp`. Change one with Chord's `evolve`, and map the
  version before it where the server serves the type (`accepts`), so released apps keep working with newer servers;
  never edit a released version or a schema it names (`docs/server-plugins.md`, "Contract versions").
- An app holds no server release and never compares one of its own with a server's. Whether the two fit is Chord's
  contract versions, and whether a side can read a conversation is pi-durable's own versions. A server is out of date
  when it is behind the newest release published (`infinichat-remote/release.ts`, `behindNewest`).
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

## On a machine that runs the owner's server

- The owner's live conversation is in `~/.infinichat/data/infinichat-store.db`, a Chord store, and in
  `infinichat.db` beside it until server 5.1.0 has converted it. Read it only with
  `sqlite3 "file:...?mode=ro"`; never write it, and never send a message into it.
- `/reload-plugins` is the user's command, and restarting or signalling `infinichat.service` is the owner's call. Its
  log is `journalctl --user-unit infinichat.service`.
- Try things in a scratch `HOME` or with a scratch configuration, never on the owner's apps or the real display, and
  leave nothing behind. For Cua Driver set `DO_NOT_TRACK=1` and `CUA_DRIVER_RS_UPDATE_CHECK=false`, and do not run its
  installer or uninstaller, which end the live server's driver (`docs/server-plugins.md`).

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

This project (`eas.json`, EAS project `pi-agent`): `production` is the App Store build, sent to TestFlight by
`npx eas-cli@latest build -p ios --profile production --auto-submit --non-interactive` (the signing credentials and
the App Store Connect key are on EAS, so any signed-in machine can run it); `development-simulator` is the unsigned
development build for Expo Simulators. The profiles pin pnpm to the version that wrote the lockfile: the build
image's pnpm 11 fails the install on this workspace's build-script settings (`ERR_PNPM_IGNORED_BUILDS`), so move the
pin with the workspace. EAS's Mac images have no Rust; the pre-install hook installs it and builds the SSH archive.
An iOS app holds no program of another system: Xcode's export finds a macOS Mach-O file among the app's files and
fails with `No signing certificate "Mac App Distribution" found`. So the phone bundles the pi-env daemons gzipped
(`packages/infinichat-server/assets/pi-env-gz`, which `scripts/sync-daemons.mjs` writes beside the plain ones the Mac
app ships) and inflates the one a machine needs (`daemon-assets.ts`).

A build uses the owner's build minutes and a store build takes a new build number, so find a failure's cause first
and build once: `npx eas-cli@latest build:list --limit 5`, then `build:view <id> --json`, whose
`artifacts.xcodeBuildLogsUrl` is the full Xcode log and whose `logFiles` are JSON lines with each line's phase
(brotli-compressed, which `fetch` undoes and `curl` does not). After a store build, `submit:view <id>` says how far
the submission got: `finished` is the upload to App Store Connect, and Apple's processing after it shows only there
and in TestFlight.

The build number is `ios.buildNumber` in `app.json` (`appVersionSource: "local"` in `eas.json`), which
`autoIncrement` raises by one in that file as a store build starts: commit the change with the build. Expo
recommends the remote source, but expo-widgets gives its extension the number the app config has at prebuild
(`withTargetXcodeProject` in its plugin; expo/expo issue 43740), and EAS writes a remote number only into the
`Info.plist` files, after prebuild. With the remote source the extension stayed at 1, and each archive warned that
it did not match the app's.

Without the Mac (a Linux machine such as the owner's server machine), the app runs on an EAS Simulator session, which
`@expo/agent-cli` plans, starts, drives and ends (`npx @expo/agent-cli dev --help`). It automates Expo's "Use an iOS
Simulator on Linux or Windows" (https://docs.expo.dev/eas/simulators/how-to/work-without-a-mac.md), so run it instead
of that page's `expo start` and `eas simulator:start`:

1. `npx @expo/agent-cli dev --ios --eas --plan` says what would run, and runs nothing. While EAS has a
   `development-simulator` build for the project's fingerprint it is one step, the dev server over a tunnel. An
   `eas build` step uses build minutes: expect one only after a native change (`npx @expo/agent-cli status` says).
2. `npx @expo/agent-cli dev --ios --eas --detach --wait-ready` runs the plan: the dev server, and a session with
   that build installed and opened on it, whose ID it prints. The session bills until it is stopped.
3. `npx @expo/agent-cli navigate <route> --eas` opens a screen there. `runtime:tree`, `runtime:tap`, `runtime:type`,
   `runtime:eval` and `runtime:errors` reach the app through the dev server: leave out `--ios`, which looks for a
   device on this machine. The CLI takes no screenshot, and taps and types only by testID, so for a screenshot and
   for an element without one use the session's own controls: `npx eas-cli@latest simulator:control
   screenshot.capture --output <file>`, `tap <x> <y>` (each from 0 to 1) and `type <text>`, with `--id <session>`.
4. `npx @expo/agent-cli dev:stop --eas` ends the session and the dev server.

`apps/mobile/.gitignore` holds only the blocks `expo start` and the CLI's skills sync generate, committed as they
write them. Expo's fingerprint hashes that file (`bareGitIgnore`), so without it every run left a new one behind and
the next plan began with an `eas build` nobody needed. A run leaves `git status` clean; a change to the file changes
the fingerprint, and so needs a new `development-simulator` build.

The remote simulator is not on the owner's network, so it reaches no machine over SSH: connecting to a machine is
still checked on the iPhone, from TestFlight.

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
