# References

Checked on 2026-10-26 at revision `348f26a` (branch `feat/agent-name-avatar`). Versions:
- **pi:** pi-durable, pi-ai, chord and pi-env 1.4.0, the latest on npm (published 2026-10-21, tag `4a080252f`).
  Upstream `main` at `2685de7a1` (2026-10-22) has no change to pi-env's `ConnectionOptions`.
- **App:** Expo 58.0.17, React Native 0.88.0, react-native-ssh 0.3.0, react-native-nitro-zlib 0.3.1,
  TypeScript 6.0.3, esbuild 0.28.2, pnpm 10.33.0.

`file:line` references are at those versions.

## Upstream contracts

| Contract | Source |
| --- | --- |
| One process owns a storage; no cross-process locking | pi-durable `README.md:790` |
| A session document is one per storage: `scope: 'session'`; `tx.doc`, `watchDoc`, `snapshot`, `documentState` take its token alone | pi-durable `dist/types.d.ts:44-47`, `:877`, `:920`, `:954`, `:960` |
| `Harness extends Session`: the Harness commits and observes session documents | pi-durable `dist/harness/types.d.ts:723` |
| `documentState()` never creates a document; `tx.doc()` creates it on first use | pi-durable `test/examples/04-chord-state.ts` (tag `v1.4.0`) |
| Clients attach to one Harness through Chord views; a late joiner starts from the current view | pi-durable `README.md` "Watching a Conversation", `test/examples/21-late-join.ts` |
| No CRDT or offline multi-writer merge | pi-durable `docs/spec.md` §13 (tag `v1.4.0`) |
| The portable SQLite and JSONL cores run without Node APIs, given a `SqliteDatabase` facade or a `FileSystem` | pi-durable `README.md:790` |
| `env` builds an `ExecutionEnv` for each tool call | pi-durable `README.md:427-441` |
| `FileSystem`, `Shell`, and `ExecutionEnv extends FileSystem, Shell` | pi-durable `dist/env/index.d.ts:164`, `:292`, `:302` |
| `exec` takes no stdin; aborting kills only that command's processes | pi-durable `dist/env/index.d.ts:237-253`, `:292-298` |
| A Chord server host owns the Durable Harness | chord `docs/guide.md:756` "Durable", `:712` "Hosts and links" |
| A held reference stays readable while a link reconnects | chord `docs/guide.md:396` "References" |
| `host.connect(link)` sets or replaces the link to the parent; references re-hold over it | chord `dist/host.d.ts:171` |
| `Link`: `closed`, `send`, `receive`, `onClose`, `close` | chord `dist/link.d.ts:3-16` |
| pi-env's `Connection` takes only a command to start the daemon | pi-env `dist/connection.d.ts:36-45` |
| `Connection` has `#private` fields | pi-env `dist/connection.d.ts:72-74` |
| `Connection` starts again by itself after a loss; `close()` kills everything the daemon started | pi-env `dist/connection.d.ts:69-70`, `:80` |
| The daemon starts with `node:child_process` | pi-env `dist/connection.js:1`, `:208` |
| `RemoteExecutionEnv` imports `node:crypto`, `node:path`, `node:string_decoder`, `node:url` | pi-env `dist/remote-env.js:1-4` |
| `sshArguments` disables forwarding of any kind | pi-env `dist/ssh.d.ts:42-46` |
| The wire protocol: the client discards output before the sync line; frames of at most 16 MiB, split by the client | pi-env `docs/protocol.md`, "Sync" and "Frames" |
| Monorepos: Metro configured automatically from SDK 52; isolated installs from SDK 54; `apps/` and `packages/`; `workspace:*`; no duplicate React Native or native modules | `https://docs.expo.dev/guides/monorepos/` (read 2026-10-26) |
| JSONL storage opens on any `FileSystem` | pi-durable `dist/storage/jsonl/storage.d.ts:27` |
| Unreleased session sync keeps a remote in a folder on any `FileSystem` ("for development and tests, with one process writing") | pi `replication` branch at `f6f3d5507` (2026-10-24), `packages/durable/src/sync/filesystem.ts` |
| One object per principal key: two tabs of the owner share an object | chord `docs/guide.md:356` |
| A client that joins mid-run gets the current state, then only changes | pi-durable `test/examples/21-late-join.ts` (v1.4.0), `README.md:853` |
| A chat's environment built per call from its committed target | pi-durable `test/examples/29-sandbox-per-conversation.ts` (v1.4.0) |

## Several clients on one server

Chord and pi-durable already serve several clients at once. Every connection to the server acts as
`{ kind: 'owner' }` (`server/listen.ts`), and Chord gives one object per principal key (chord `docs/guide.md:356`), so
the phone and the Mac would share one object and see the same live state. pi-durable's late-join example shows a client
attaching mid-run and catching up. Watching and using InfiniChat from both at once needs no change.

What assumes a single client is the app's own code:

| Assumption | Where | What two clients would do |
| --- | --- | --- |
| One secret, which an install replaces: "another phone's secret is refused from then on" | `server/listen.ts` (`authorized`), `src/pi/infinichat-remote/install.ts:363` | A Mac installing with its own secret locks the phone out; the phone's next connect reinstalls and locks the Mac out |
| The phone's home record decides who may open the database | `src/pi/infinichat-remote/home.ts`, pi-durable `README.md:790` | A move started on the Mac leaves the phone's record wrong |
| `setMachines` replaces the server's list of other machines | `server/machines.ts:101` | The phone and the Mac configure machines separately, with their own IDs, and overwrite each other's list at every connect |
| `setTimeZone` sets the server's zone | `server/state.ts:62` | Harmless while both are in the same zone |

## Two seams, two questions

pi-durable answers two separate "where" questions, with a seam for each:

- **Where the Harness runs:** its storage, model calls and tasks (turns, summaries, agents, scheduled tasks). One
  process opens the `Storage`. Seeing and driving it from elsewhere is Chord's job: a host serves the Harness, and
  clients connect over a `Link`. RemoteInfiniChat is such a client.
- **Where an agent's tools run:** the `ExecutionEnv` the Harness's `env` returns for each tool call. pi-env's
  `RemoteExecutionEnv` is upstream's answer for another machine.

Install and move act on a machine's files and run commands there, which is the `ExecutionEnv` question. That is why
piece 4 recommends it, while piece 3 uses the `Link`.

## pi-env's plug points

| Plug point | iPhone | Server |
| --- | --- | --- |
| The daemon and its protocol | Uses upstream's binaries, pinned to the 1.4.0 tarball by integrity (`scripts/sync-pi-daemon-assets.mjs`), and speaks protocol 1 | Uses them |
| `ConnectionOptions.command` | Can't: the command runs as a child process, which iOS doesn't allow | `connectSsh` |
| `RemoteExecutionEnv({ connection })` | Can't: it accepts only pi-env's `Connection` class, and its module needs Node APIs Hermes lacks | `server/machines.ts:94` |

So the phone keeps the daemon and its protocol, and ports only the TypeScript client: `src/pi/execution/remote/`,
1,701 lines for `connection`, `environment`, `readers`, `list-files`, `watch`, `errors`, `paths` and `protocol`,
against 1,419 in upstream's matching files. `environment.ts:1` says "Adapted from Pi Env 1.4.0 remote-env.ts (MIT)";
`DaemonChannel` (`channel.ts:8`) stands in for `command`.

`readers.ts:1` cites pi-env 1.1.0. Since then upstream's `remote-env.ts` changed once (`b6fda579f`, adding
`listFiles` and `nodePlatform`), and the port has both, so it hasn't drifted.

Removing the port would take an upstream change: `ConnectionOptions` accepting a byte-stream opener besides a command,
and client modules that load without `node:*` imports.

## The shared set

A scan of `import` and `export … from` statements, following relative paths from `server/main.ts`, reaches these 35
files (5,338 lines). Each imports only pi packages (`@earendil-works/chord`, `pi-ai`, `pi-durable` and their subpaths)
and other files in the set:

| Group | Files |
| --- | --- |
| OptChat core | `src/pi/infinichat/{agents,app,device-tools,memory,names,prompt,schedule,summary,tools}.ts` |
| Service and view | `src/pi/{infinichat-service,infinichat-view,infinichat-scheduled}.ts` |
| Chat view model | `src/pi/{chat-view,chat-projection,chat-metadata,user-input}.ts`, `src/pi/workspace/document.ts`, `src/pi/execution/document.ts`, `src/pi/native-web-search/{bindings,decoders,documents,durable,entries,presentation}.ts`, `src/chat/{types,file-tool-presentation,web-search-types,web-search-url,auth-prompt-controller}.ts` |
| Models and sign-ins | `src/pi/{model-catalog,model-auth,provider-credentials}.ts`, `src/pi/openai-auth/core.ts` |
| Remote contract | `src/pi/infinichat-remote/{contract,pages}.ts` |

The exception is `provider-credentials.ts:5`, a type-only import of `src/pi/secure-storage.ts`, which imports
`expo-secure-store`. `server/credentials.ts:6` and `src/pi/execution/remote/hosts.ts:3` import the same type from it.

## The 48 importers

The same scan finds 48 files outside the set that import from it: 10 in `server/` and 38 in the app. The typecheck
after the move is the authority on the exact set.

- `server/`: `conversation`, `devices`, `listen`, `machines`, `main`, `models`, `pages`, `serve`, `sign-in`, `state`.
- `src/app/`: `(tabs)/(infinichat)/index.tsx`, `(tabs)/chats/chat/[id].tsx`, `chat-settings/[id]/index.tsx`,
  `chat-settings/[id]/model.tsx`, `infinichat-schedule/{edit,index}.tsx`,
  `infinichat-settings/{_layout,index,model}.tsx`.
- `src/chat/`: `chat-provider.tsx`, `photo-attachments.ts`, `provider-account.ts`, `shown-infinichat.ts`.
- `src/components/chat/`: `auth-prompt.tsx`, `message-images.tsx`, `message-row.tsx`, `provider-section.tsx`,
  `settings-controls.tsx`, `settings-drafts.tsx`, `source-link.ts`, `tool-card.tsx`, `transcript.tsx`,
  `web-search-presentation.ts`, `web-search.tsx`.
- `src/hooks/use-transcript-scroll.ts`, `src/keep-alive/controller.ts`.
- `src/pi/`: `chat-service.ts`, `images.ts`, `infinichat-notifications.ts`, `infinichat-phone.ts`, `models.ts`,
  `infinichat-remote/{client,install,move}.ts`, `infinichat/devices.ts`, `native-web-search/provider.ts`,
  `openai-auth/{browser,index}.ts`.

## A typecheck without host types

A throwaway `tsconfig` in the session scratchpad (not committed), with `types: []`, `lib: ["ES2024"]`, `strict` and
`moduleResolution: "bundler"`, typechecked the set without errors. `--explainFiles` showed why that proves less than it
seems: Node's types still load. pi-ai bundles `@anthropic-ai/sdk`, whose `internal/types.d.mts` imports
`undici-types`, which references `@types/node`. So the compiler can't keep Node APIs out of the package; the lint rule
in piece 2 does.

## Native modules on macOS

| Package | What it ships |
| --- | --- |
| react-native-ssh 0.3.0 | `ios/RnsshFFI.xcframework` with `ios-arm64` and `ios-arm64_x86_64-simulator` only; the podspec declares iOS only |
| react-native-nitro-zlib 0.3.1 | The podspec declares iOS 16.0 only |

Neither builds for Mac Catalyst or react-native-macos as shipped. Under the owner's assumption (2026-10-26), the Mac
app runs on Node or Bun and uses pi-env, the system `ssh`, `node:sqlite` and `node:zlib` instead.

## Unverified until a piece checks it

- Metro resolving the `"./*": "./src/*.ts"` subpath pattern (piece 2).
- pnpm 10 still running `react-native-enriched-markdown`'s postinstall once a `pnpm-workspace.yaml` exists (piece 2).
- `npx @expo/agent-cli install` accepting the `workspace:` protocol (piece 2).
- Piece 4: the server surviving the daemon connection's close, the phone's port splitting large
  writes into frames, and the permissions of input files inside `~/.infinichat`.
- Anything about the Mac app's framework, its keychain, or how it runs the server.
