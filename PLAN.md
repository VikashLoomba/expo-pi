# pi-agent Cleanup Plan

2026-10-10

Simplify pi-agent onto idiomatic pi-durable, pi-env and Expo. Implementers follow `AGENTS.md`. Order: P1, then P2,
then Docs, then Later. A phase is done when its "Done when" holds and typecheck, lint and `git diff --check` pass.

## How the app fits pi

The app runs pi-durable, pi-ai and chord on iOS, and pi-env's daemon on remote hosts. Each library defines a seam, and
the app plugs an Expo implementation into it. "Upstream" means those libraries at the vendored pi-repo revision (see
"Upstream revision"): their types, READMEs and `test/examples`. pi's coding-agent app is not a reference.

| Seam | pi contract | Expo / iOS | App code |
| --- | --- | --- | --- |
| Run in Hermes | pi-ai "Browser Usage": side-effect-free entry points that bundle cleanly | Metro, Hermes, expo-crypto | `packages/expo-pi` |
| Conversation storage | pi-durable "Storage": the portable SQLite core over an async `SqliteDatabase` facade | expo-sqlite | `src/pi/storage/` |
| Credentials | pi-ai `CredentialStore` (`read`, `list`, `modify`, `delete`), injected with `createModels({ credentials })`; README "Credential Store" | expo-secure-store (Keychain) | `provider-credentials.ts`, `secure-storage.ts` |
| Provider sign-in | pi-ai `OAuthAuth` (`login`, `refresh`, `toAuth`) run by `models.login(provider, 'oauth', interaction)` | expo-auth-session, expo-web-browser, the Swift loopback module | `src/pi/openai-auth/`, `modules/pi-oauth-callback` |
| Chats and UI state | pi-durable `Storage.scanConversations`, `conversation.entries()`, documents, `viewState()`; README "Concepts", "Watching a Conversation" | expo-router | `chat-service.ts`, `chat-view.ts`, `chat-projection.ts` |
| Chat actions | expo-router `Stack.Toolbar.Menu` and `Link.Menu`; React Native `Alert` | iOS menus and alerts | `chat-actions.tsx`, `app/index.tsx`, `app/chat/[id].tsx` |
| Sending while busy | pi-durable "Busy Conversations": `whenBusy`, `pi.inbox`, `submission.abort()`; example 20 | none | P2 |
| Tools | pi-durable `CodingTools` | none | `chat-service.ts` |
| Prompt | pi-durable extensions and sections; README "System Prompt" | none | the `assistant` section |
| Local execution | pi-durable `ExecutionEnv`, reference `NodeExecutionEnv`; the `env` resolver, example 29 | expo-file-system, just-bash, the cache directory for `/tmp` | `src/pi/workspace/` |
| Remote execution | pi-env 1.1.0's daemon protocol, reference `RemoteExecutionEnv` at the tag; the app ships the daemon from `assets/pi-env` | react-native-ssh | `src/pi/execution/remote/` |
| Web search | pi-ai provider decorator: the built provider spread with `stream`/`streamSimple` overridden (plain object from `createProvider`); pi-durable write entries | none | `src/pi/native-web-search/` |
| Keep-alive (Later) | pi-durable `resume()`, `taskGraph()` | expo-widgets, expo-location, expo-task-manager | none |

## Upstream revision

The vendored tarballs in `vendor/pi/` are built from the pi repo's `main` at `ea448f4` (2026-10-10, after 1.1.0,
before the next release; packed as 1.1.0). npm has no newer release and the repo publishes no canary.
`package.json` points the three direct dependencies at the tarballs, and `pnpm.overrides` pins every
`@earendil-works/*` package, including the transitive `pi-telemetry`, to the same files, so one instance of each
exists. pi-env is not an app dependency: the daemon assets come from npm pi-env 1.1.0, and its `[Unreleased]` is
empty, so the ported remote environment and the shipped daemon match main. When the next npm release ships, delete
`vendor/` and the overrides and go back to registry versions.

Why tarballs and not `git+https`: pnpm does install monorepo subdirectories (`#<sha>&path:packages/durable`), but
the repo checks in neither `dist/` nor a `prepare` script, so a git install cannot resolve the packages' `dist`
exports (verified with pnpm 10.33: `MODULE_NOT_FOUND`). The `"source"` export condition does not help: pi-ai's
checked-in `.models.ts` files import `./data/*.json`, and those catalog files are generated at build time and never
committed. Upstream publishes no canary dist-tag and no per-package tarballs on GitHub releases. The only git-URL
route, a fork with `dist` and data committed, is more to maintain than regenerating tarballs from a pinned sha.

Regenerate from a clone at the wanted revision:

```sh
git clone https://github.com/earendil-works/pi.git /tmp/pi-upstream && cd /tmp/pi-upstream
git checkout <revision> && npm install
cp -r <app>/node_modules/@earendil-works/pi-ai/dist/providers/data packages/ai/src/providers/data
for p in chord telemetry ai durable; do (cd packages/$p && npm run build:offline 2>/dev/null || npm run build); done
for p in chord telemetry ai durable; do (cd packages/$p && npm pack --ignore-scripts --pack-destination <app>/vendor/pi); done
```

Model data is hydrated from the previously installed pi-ai, so the catalog the owner verified is the one that ships.
`npm run build` in `packages/ai` would fetch live model data instead; that is a separate decision with an app-facing
catalog change (`NEW_CHAT_DEFAULTS` pins model ids). `build:offline` exists only in pi-ai; the other packages have a
plain `build`.

What main changes for the app (pi-durable `[Unreleased]`):

- A storage error ends the Harness: every call rejects with `SessionFailed`, running tasks get their abort signal,
  and `harness.closed` settles `{ reason: 'failed', error }`; reopen to recover (README "Errors"). Adopted in
  `159669d`. A `close()` after the Harness failed on its own returns the same settled close.
- `bash` answers a nonzero exit with an error result carrying an `exit_code` diagnostic instead of throwing
  `tool_error`; the tool card renders pi's error result as before.
- `read` returns image blocks for common image types. The app's envs already return bytes, and a chat whose model
  takes no images gets pi's placeholder diagnostic; the transcript projects text only.
- Nested tool calls (`api.executeTool`), `callers`/`modelTools`, `structuredOutput`, `abandonOnRestart`: additive,
  unused by the app.
- Scheduler performance and memory fixes; a throwing `onReport` is contained; watch-listener errors are reported.
- pi-ai `[Unreleased]`: one Mistral timeout fix, unused by the app. chord and pi-env: no changes.

The harness guide's version table names seven of these differences and defers to the CHANGELOG's `[Unreleased]`
section as the exact diff; all seven hold for `ea448f4` (tool `output`, `SessionFailed`/`harness.closed`,
`executeTool`, `callers`/`modelTools`, the bash `exit_code` diagnostic, image reads, `ToolHookCall`). The CHANGELOG
at `ea448f4` adds what the guide predates: `pi.tool` v2 with live migration, `StorageRequestError`, listener throws
reported instead of failing, `abandonOnRestart`, `abortOwned`/`ownedTasks`, `retainedOutput`, `NestedCallDoc`, and
the scheduler, `onReport`, watch-listener and Mistral fixes. The guide's `version.check-dts` rule applies unchanged:
code against the installed declarations, which are now the vendored main ones.

Verified against main before adopting: the invocation-signal flow the per-request correlation relies on
(`scheduler.ts` context, `generation.ts` stream options), generation's `streamSimple` dispatch, `createProvider`'s
plain-object provider (the spread decorator), the partial's `responseId` from `response.created`, pi-ai's own
`include` for active reasoning, write submissions with `requestId` (example 20), the fire-and-forget commit report
(`generation.ts`), idempotent `close()`, and the expo-pi transform's targets (variable `import()`, chord's
descriptor call, `getRandomValues`). Examples 20 and 29 are unchanged from 1.1.0.

## Done

- Specs retired: `2d39ec6`; the remaining specs in `docs/` were deleted in `c705cba`.
- Auth without the legacy Codex login: `b8c91f9`.
- Chat service and runtime on pi-durable views: `081e7eb`.
- Local workspace on a real directory: `6ecd402`.
- pi 1.1.0: `c705cba`. All tests and test scripts deleted: `1a2a418`.
- Execution seam, `CodingTools` and fork removal: `e859237`; the `env` resolver and plain remote owner: `ece3f78`;
  Expo filesystem fixes: `97acae3`.
- P1 Delete: `29b1fd6`, `67565e8`, `d7cefbe`, `c30ab4f`, `35b8324`, `2cd1c99`.
- P1 Local environment: `ac49fa8`.
- P1 Remote environment: `bfce5af`, `2cd1c99`.
- P1 Chat service and runtime: `498aa7f`, `cf5ac5f`, `2fd5deb`, `9bd01f9`, `f5ad9c7`, `b433149`.
- iOS only (Android target removed): `f5ad9c7`.
- Plan re-audit fixes: `70e9169`, `1ef9e52`.
- pi main `ea448f4` as vendored tarballs: `27ee82e`; close order and `harness.closed` reopen: `159669d`.
- `node:zlib` resolved empty for just-bash; stub deleted: `78eb811`.
- WS-1 web search data side: `40021dc`; WS-2 rendering: `d8fe9a9`. Old chats' web-search records live in documents they replaced; clear app data.

## Open items

| Item | What it is | Status and next step |
| --- | --- | --- |
| Web search and Markdown (WS-1, WS-2) | Replace about 1,900 lines with pi-ai's documented stream decorator, one app entry per search and one presentation document; citations render as the Markdown links the model already writes. | Done: WS-1 `40021dc`, WS-2 `d8fe9a9`. |
| Device checks | Every "Done when" device check. Verified on the owner's iPhone (2026-10-10, Release build through `d8fe9a9`): ordinary chat, bash, a real ChatGPT search (activity, sources, Markdown-link citations), a follow-up using the results, stop mid-search, rename/delete; no regressions from the main upgrade. | Remaining: spill-file readback and `/tmp` isolation, the remote-host checks (real-host tools, one daemon session shared by two chats, credential change at next connection start), and a forced storage failure closing and reopening chats. |
| `MessageRow` and `CodeBlock` lost `memo` in `70e9169` | React Compiler does not compile them (a `throw` inside `try/catch`). Nothing depends on their identity, and FlatList's cell renderer already skips unchanged rows. | No action unless a device run shows a problem. |

## P1: Delete and replace known-bad code

Nothing with a known replacement stays. Pure deletions come first; each replacement after them names the pi contract
it follows (see the map).

### Delete

- [x] Delete the `coding_tools`, `local_workspace` and `remote_machine` prompt sections; pi-durable sends each tool's
  own description. Keep `assistant` as it is.
- [x] Drop `compaction: { backgroundTokens: 0 }` from `chat-service.ts`; pi-durable's default applies.
- [x] No busy guards: a settings, working-directory or machine change applies from the next request or tool call, as in
  pi-durable. Delete the `assertIdle` uses, the task scan and the `updateState` hook. Busy means
  `live.run !== undefined`.
- [x] Delete each of these that nothing in `src` calls: `waitForSubmission`, `ChatViewSnapshot.conversation`, the
  `restoring` memo, optional `Credentials` members, `getCatalog` and the `extensions` option.
- [x] Delete memoization: the row cache, entry-identity bookkeeping and `sameControls`.
- [x] Delete memoization: `shareBlocks` and the two-trailing-block cache.
- [x] `requireAuth` drops `checkAuth`.
- [x] `readTextFile` reads like `NodeExecutionEnv`'s `readFile(path, 'utf8')`: invalid bytes become U+FFFD. Remove the
  strict decoder from the local environment.
- [x] `readTextFile` reads and decodes as upstream's `#readFile` does, like Node's `readFile(path, 'utf8')`: invalid
  bytes become U+FFFD. Remove the strict decoder from the remote environment and delete `strict-utf8.ts`.
- [x] The remote line reader uses pi-durable's `StreamDecoder`; delete `remote/utf8.ts`.
- [x] Restore library and upstream defaults:
  - the SSH library's keepalive (15 s, 3 missed), instead of 10 s and 2;
  - no app `OUTPUT_LIMIT` in `command-channel.ts`;
  - upstream's start timeout for the daemon hello, kept separate from provisioning.
- [x] Delete the remote environment's dead code, found by symbol:
  - the duplicate callback-error capture;
  - the waiter-counting teardown on abort.
- [x] Remove `Connection`'s test-only options.
- [x] Delete the remaining web-only code:
  - `host-storage.web.ts`, `PiOAuthCallbackModule.web.ts` and the web branch in `remote-hosts.tsx`;
  - the `app.json` `web` block, plus the `expo-router` plugin's COEP/COOP headers and `web.output`;
  - the cross-origin headers in `metro.config.js`, and the `wasm` asset extension if nothing native needs it
    (keep `bin`);
  - the `web` script and the empty `modules/codex-callback/` directories; `withPi(config, { web: true })` in
    `metro.config.js` becomes `withPi(config)`.
- [x] Web is no longer a valid target. Remove the web-target conditionals and code. Leave `packages/expo-pi` unchanged.
- [x] Delete the `memo(...)` wrappers left on `ContentBlock`, `InlineContent` and the table `Row`. Their props are
  rebuilt on every update, so they never skip a render.
- [x] Android is no longer a target: `"platforms": ["ios"]`, no `android` config or script, no Android-only branches.
  Remove `@expo/dom-webview` and the template images nothing references.
- [x] Manual `memo`, `useMemo` and `useCallback` go where React Compiler compiles the code (Expo's React Compiler
  guide). They stay where it does not: `useProviderSignIn` and the chat screen (both contain `try … finally`), and
  `memo` on `ChatTranscript`. The `useMemo` that creates the `ChatView` stays because it creates a resource.
- [x] Delete the daemon-binary promise cache, the chat-list microtask batching, `scripts/reset-project.js`, and the
  backwards-compatibility reasoning in the credential comments. Load the OAuth callback module with
  `requireNativeModule`.

### Local environment

- [x] Temp files and spill, as `NodeExecutionEnv` does them:
  - Each workspace gets its own temp directory under Expo's cache directory (`Paths.cache`), created when the
    environment is built, exposed as `/tmp` to both `exec` and the file methods. It replaces the per-command in-memory
    `/tmp`.
  - `createTempDir` and `createTempFile` make unique entries there, as `NodeExecutionEnv` does with `mkdtemp` (a
    non-idempotent `Directory.create()` and pi-ai's `uuidv7`).
  - `exec` honours `spill`, applied to just-bash's result, including partial output on abort or timeout, and returns a
    `/tmp/…` path the model can `read`.
  - Nothing deletes temp files; the system may purge the cache.
- [x] Match `NodeExecutionEnv` where Expo and just-bash allow it:
  - `exec` passes just-bash's partial output on abort or timeout to `onOutput`;
  - `remove` without `recursive` refuses directories;
  - `absolutePath` accepts `file://` URLs, and `joinPath` keeps a trailing slash;
  - check for abort after each read and write, as `NodeExecutionEnv` does.

Known limits: truncate rewrites the file, `flushFile` cannot fsync, no symlinks, directory info has no size or mtime,
directory listing is a snapshot, output arrives when the command ends, `watch` returns `not_supported`. **No work is
required for these known limitations. Do not implement any code, comments, tests, or otherwise. Leave the current
behaviour for them as it is. These limits are enumerated here just to make it clear they are not meant to be dealt
with.**

### Remote environment

`MobileRemoteExecutionEnv` is pi-env 1.1.0's `RemoteExecutionEnv` running over react-native-ssh, because upstream's
`Connection` spawns `ssh`. It matches upstream's `remote-env.ts` and `watch.ts` method by method, and differs only in
the SSH transport and Hermes replacements for Node modules.

**Connections**

- [x] One `Connection` per machine, keyed by machine id. Build `{ connection, id, cwd }` environments on it at each
  use, as the pi-env README and `test/ssh-external.test.ts` do. The owner forgets a connection when it closes it; the
  next resolve creates a new one.
- [x] Admit at every connection start: `openChannel` reads the machine's credentials and trusted key each time it
  runs, as upstream evaluates `ConnectionOptions.command` at each start (`connection.ts:256-259`). No cached admission.
  Detect the platform once per connection, as upstream does.

**Environment**

- [x] `cleanup()` matches upstream's `RemoteExecutionEnv.cleanup` (`remote-env.ts:932-936`): it kills the commands it
  started and nothing else. Shutdown closes each connection in the owner's map. Everything that left unused is
  deleted.
- [x] `watch` matches upstream's `RemoteExecutionEnv.watch` and `RemoteWatcher`.
- [x] The abort signal goes only with `scanLines` and `exec`, as upstream does; `~` paths and `createTempDir` use the
  cached `connection.info()`.
- [x] Typed reply decoders replace the casts and non-null assertions, including the `JSON.parse` results in
  `hosts.ts`; static imports in `channel.ts` and `daemon-assets.ts`.
- [x] Upstream's frame handling: unknown frame types are ignored; no outbound frame-size or request-id checks.
- [x] `SshChannelDependencies` and the other test-only injection are deleted.
- [x] The silence clock starts when the daemon's channel opens, as pi-env's `Connection.#start` does.
- [x] `remote/composition.ts` is `remote/owner.ts`; `remoteHostConnectionMessage` is not exported.
- [x] Only the host test sets a connect timeout (120 s), because react-native-ssh's timeout spans `verifyHostKey`,
  which waits there for the person comparing the fingerprint. Every other connection uses the library default.

Known limits: upstream's write constants stay, so a single write over about 4 MiB can overflow react-native-ssh's write
queue (`QUEUE_FULL`) and drop that machine's connection. A reconnect while the phone is locked fails, because admission
reads the Keychain. No work for these.

**Settings UI**

- [x] A remote working directory is optional and saving it needs no network. Blank is stored as `cwd: null`, and the
  environment uses `(await connection.info()).home`, as pi-env's `test/ssh-external.test.ts` does.
  `resolveRemoteWorkingDirectory` and its UI are deleted.

**Keep:** automatic daemon provisioning; host-key checks (algorithm, fingerprint and public key); `quotePosix`;
hex-validated tokens; SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

### Chat service and runtime

Built on pi-durable's conversations, entries and documents, read through `viewState()` and `subscribeCommits` (map row
"Chats and UI state"). The title, rename, delete and ordering rules below are product decisions.

**Chat list and chat actions**

- [x] The chat list reads each chat's `ChatMetadataDoc` (README "Your Own State"). The document holds `title`,
  `preview`, `updatedAt`, `createdAt`, `lastInput` and `deleted`. The list skips deleted chats and orders by
  `updatedAt`.
- [x] Send: one commit right after `submit()` returns sets `lastInput`, `updatedAt` and `preview`, and `title` if it is
  unset. Each draft keeps one `requestId`, so a resend returns the existing submission (README "Persist and Resume").
- [x] Rename: a commit that sets `title`. It applies at once, even while the chat is busy.
- [x] Delete chat: `conversation.abort()`, then a commit that sets `deleted`, then remove the chat's workspace
  directories through `Workspaces.remove(id)`. A failed removal raises `WorkspaceRemovalError` and shows as an alert;
  the chat stays deleted. Deleting the open chat goes back to the list. Archive is gone.
- [x] The chat options are native iOS menus: `Stack.Toolbar.Menu` in the chat header and `Link.Menu` on list rows
  (Model settings, Rename, Delete). Delete confirms with `Alert.alert`; Rename uses `Alert.prompt`. The shared error
  banner can be dismissed.
- [x] Latest outcome: on connect, read `lastInput`, then `harness.submission(id)`, and follow its `status()` and
  `wait()` (example 20). Show only outcomes the transcript does not already show.
- [x] The chat's `ExecutionTargetDoc` is created in `createChat`'s `init`, as examples 06 and 29 create a document they
  later read.

**Auth and runtime**

- [x] Expired sessions: keep the credential, as pi-ai documents (`getAuth` rejects with ModelsError `oauth`; re-login
  fixes it). A refused refresh marks the provider "Session expired — sign in again" in memory; a send shows that
  message only while the mark is set. Signing in replaces the credential and clears the mark.
- [x] API keys: the account screen's Save writes the key with `credentials.modify(providerId, async () =>
  ({ type: 'api_key', key }))`, the `CredentialStore` contract's only write path; `models.login` ends in the same
  `modify`. The account screen does not change.
- [x] Sign-in single-flight lives only in the account hook. `ChatRuntime` is folded into the provider.
- [x] One error model: operations return their own errors to the screen that started them. The runtime keeps only
  "chats could not open" and harness reports.

Keep the app-written OAuth adapter and Swift loopback module, the manual-entry fallback when the callback receiver
cannot start, and `transport: 'sse'`.

### Web search and Markdown

Web search keeps showing search activity, sources and citation links, and the model sees the findings on later turns.

**Recorded on 2026-10-09** from the app's own archive on the owner's iPhone (one ChatGPT response: 4 searches, 83
results, 3 citations; sanitized copy in `docs/web-search-recording.json`):

| Question | Answer |
| --- | --- |
| Where completed searches arrive | `response.output_item.done` during the stream, with `action` (`queries`, `sources`) and `results`. `response.completed` has an empty `output`. |
| Shape of a result | `{ type: 'text_result', title, url, snippet }`. `open_page` calls carry a `url` and page-text results; `find_in_page` never appeared. |
| Where citations arrive | `response.output_text.annotation.added`, repeated in the message's `output_item.done`. |
| Citation markers in the text | None. The answer already contains one Markdown link `([domain](url))` per `url_citation` span. |
| Offsets | Unicode code points, end exclusive, per message item. Not needed for rendering. |
| Messages | A short "commentary" message, then the final answer; pi-ai stores them as separate text blocks. |
| ChatGPT sign-in | Results and sources come back. |
| Cited URLs | OpenAI appends `?utm_source=openai` to cited URLs. |

**WS-1: data side**

- [x] Keep the spread-based provider decorator; it is pi-ai's exported-code form for decorating a built provider.
  `createProvider` returns a plain object, so `withNativeWebSearch(openaiProvider())` spreads it and overrides only
  `stream`/`streamSimple`, preserving auth, catalog, `refreshModels`, `filterAllModels` and the `openai-decisions`
  classifiers. `azureStreams` and `opencode-headers.ts` wrap `ProviderStreams` when building a provider from parts;
  a built provider's original streams are not reachable, so rebuilding one from parts would lose the classifiers.
  Checked against pi-ai `models.ts` at the vendored revision.
  - `onPayload`: append `{ type: 'web_search' }` to `tools`, and `web_search_call.results` and
    `web_search_call.action.sources` to `include`, keeping what pi-ai set. Never add `reasoning.encrypted_content`.
  - `onProviderStreamEvent`, as the recording shows: `response.output_item.added` with a `web_search_call` item marks
    that call running; `response.output_item.done` with a `web_search_call` item is the completed call, with its
    `action` (`search` with `queries` and `sources`, or `open_page` with `url`) and its `results` (each
    `{ type: 'text_result', title, url, snippet }`); `response.output_text.annotation.added` with a `url_citation` is a
    citation. `response.completed` carries no output items; read nothing from it. Decode every field with small typed
    decoders, no casts.
  - Only requests bound to a chat get the tool; compaction requests don't.
- [x] Keep `bindings.ts`'s per-request correlation through the request's `AbortSignal`; the bound state is only the
  chat id and a way to write, and the `{ error }` scope variant goes with the budget machinery. Verified at the
  vendored revision: the generation hook's `context.abortSignal` is the stream options' `signal`
  (`scheduler.ts`, `generation.ts`).
- [x] The `beforeRequest` hook only binds, for every generation request: the decorator wraps only the OpenAI provider,
  which is single-API (`openai-responses`), so every bound request through it is an OpenAI Responses request;
  compaction runs a `CompactionTask` whose hooks never fire here, and other `Models` calls carry unbound signals. No
  `getTask`, no pinned-checkpoint read and no `as GenerationCheckpoint` cast (AGENTS.md forbids casts), no `prepared`
  return, and no `afterResponse`.
- [x] Each completed search call becomes one app entry, written with
  `conversation.submit({ type: 'write', entry, requestId: <the search item id> })` (README "Busy Conversations",
  example 20): `data` holds the action, `model` holds the call's results as one user message of readable text. No
  budgets or caps (AGENTS.md: library defaults); a provider context overflow takes pi-durable's own
  compact-and-retry path. Don't await it in the stream handler; pass a failure to the Harness's `onReport` unless the
  request was aborted, as pi-durable does with its own streaming commits (`src/harness/generation.ts`). The transcript
  hides this one entry kind; there are no change entries.
- [x] One small presentation document per chat, `history: 'latest', fork: 'current'`, keyed by `responseId`, holding
  each search call's status, the sources (each result's title and URL) and the cited URLs. pi-ai sets
  `AssistantMessage.responseId` from `response.created`, before any search event, and `onProviderStreamEvent` observes
  it before pi-ai processes it, so the keying works for the streaming partial too; a retried request gets a new
  response and a new key. Create the document with the chat in `createConversation({ init })`, as examples 06 and 29
  create a document they later read. Commit when a call starts, when it completes, and when the decorator's stream
  ends, stopped streams included. The chat projection reads only this document. Delete `ChatView`'s late-document
  attach — the whole `subscribeCommits`/`observe` path goes, because every document the view reads now exists from the
  creating commit — and the native rendering paths in `chat-projection.ts`: `nativeRows`, `appendNative`, `orphaned`,
  `nativeByResponse`, `currentNative`, `nativeInterrupted`, `nativeTimestamp` and `ChatState.native/nativeLive`. An
  assistant row's `webSearch` is the document's entry for `message.responseId`, the streaming partial included.
- [x] Delete what this replaces: `wrapper-stream.ts`, `normalization.ts`, `archive.ts`, `migration.ts`, `budget.ts`
  (with the Models proxy passed to `Harness.open`; pass the plain `models`), `edits.ts` (already dead code today),
  `lifecycle.ts`, `persistence.ts`, `evidence.ts`, the digest index and change entries, turn-origin capture, the
  `disabled*` fields, the pre-request work and `afterResponse` in `durable.ts`, the UUIDv7 timestamp parsing, the
  duplicated helpers and the test-only exports.

Known limits: truncate rewrites the file, `flushFile` cannot fsync, no symlinks, directory info has no size or mtime,
directory listing is a snapshot, output arrives when the command ends, `watch` returns `not_supported`. **No work is
required for these known limitations. Do not implement any code, comments, tests, or otherwise. Leave the current
behaviour for them as it is. These limits are enumerated here just to make it clear they are not meant to be dealt
with.**

### Remote environment

`MobileRemoteExecutionEnv` is pi-env 1.1.0's `RemoteExecutionEnv` running over react-native-ssh, because upstream's
`Connection` spawns `ssh`. It matches upstream's `remote-env.ts` and `watch.ts` method by method, and differs only in
the SSH transport and Hermes replacements for Node modules.

**Connections**

- [x] One `Connection` per machine, keyed by machine id. Build `{ connection, id, cwd }` environments on it at each
  use, as the pi-env README and `test/ssh-external.test.ts` do. The owner forgets a connection when it closes it; the
  next resolve creates a new one.
- [x] Admit at every connection start: `openChannel` reads the machine's credentials and trusted key each time it
  runs, as upstream evaluates `ConnectionOptions.command` at each start (`connection.ts:256-259`). No cached admission.
  Detect the platform once per connection, as upstream does.

**Environment**

- [x] `cleanup()` matches upstream's `RemoteExecutionEnv.cleanup` (`remote-env.ts:932-936`): it kills the commands it
  started and nothing else. Shutdown closes each connection in the owner's map. Everything that left unused is
  deleted.
- [x] `watch` matches upstream's `RemoteExecutionEnv.watch` and `RemoteWatcher`.
- [x] The abort signal goes only with `scanLines` and `exec`, as upstream does; `~` paths and `createTempDir` use the
  cached `connection.info()`.
- [x] Typed reply decoders replace the casts and non-null assertions, including the `JSON.parse` results in
  `hosts.ts`; static imports in `channel.ts` and `daemon-assets.ts`.
- [x] Upstream's frame handling: unknown frame types are ignored; no outbound frame-size or request-id checks.
- [x] `SshChannelDependencies` and the other test-only injection are deleted.
- [x] The silence clock starts when the daemon's channel opens, as pi-env's `Connection.#start` does.
- [x] `remote/composition.ts` is `remote/owner.ts`; `remoteHostConnectionMessage` is not exported.
- [x] Only the host test sets a connect timeout (120 s), because react-native-ssh's timeout spans `verifyHostKey`,
  which waits there for the person comparing the fingerprint. Every other connection uses the library default.

Known limits: upstream's write constants stay, so a single write over about 4 MiB can overflow react-native-ssh's write
queue (`QUEUE_FULL`) and drop that machine's connection. A reconnect while the phone is locked fails, because admission
reads the Keychain. No work for these.

**Settings UI**

- [x] A remote working directory is optional and saving it needs no network. Blank is stored as `cwd: null`, and the
  environment uses `(await connection.info()).home`, as pi-env's `test/ssh-external.test.ts` does.
  `resolveRemoteWorkingDirectory` and its UI are deleted.

**Keep:** automatic daemon provisioning; host-key checks (algorithm, fingerprint and public key); `quotePosix`;
hex-validated tokens; SecureStore with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`.

### Chat service and runtime

Built on pi-durable's conversations, entries and documents, read through `viewState()` and `subscribeCommits` (map row
"Chats and UI state"). The title, rename, delete and ordering rules below are product decisions.

**Chat list and chat actions**

- [x] The chat list reads each chat's `ChatMetadataDoc` (README "Your Own State"). The document holds `title`,
  `preview`, `updatedAt`, `createdAt`, `lastInput` and `deleted`. The list skips deleted chats and orders by
  `updatedAt`.
- [x] Send: one commit right after `submit()` returns sets `lastInput`, `updatedAt` and `preview`, and `title` if it is
  unset. Each draft keeps one `requestId`, so a resend returns the existing submission (README "Persist and Resume").
- [x] Rename: a commit that sets `title`. It applies at once, even while the chat is busy.
- [x] Delete chat: `conversation.abort()`, then a commit that sets `deleted`, then remove the chat's workspace
  directories through `Workspaces.remove(id)`. A failed removal raises `WorkspaceRemovalError` and shows as an alert;
  the chat stays deleted. Deleting the open chat goes back to the list. Archive is gone.
- [x] The chat options are native iOS menus: `Stack.Toolbar.Menu` in the chat header and `Link.Menu` on list rows
  (Model settings, Rename, Delete). Delete confirms with `Alert.alert`; Rename uses `Alert.prompt`. The shared error
  banner can be dismissed.
- [x] Latest outcome: on connect, read `lastInput`, then `harness.submission(id)`, and follow its `status()` and
  `wait()` (example 20). Show only outcomes the transcript does not already show.
- [x] The chat's `ExecutionTargetDoc` is created in `createChat`'s `init`, as examples 06 and 29 create a document they
  later read.

**Auth and runtime**

- [x] Expired sessions: keep the credential, as pi-ai documents (`getAuth` rejects with ModelsError `oauth`; re-login
  fixes it). A refused refresh marks the provider "Session expired — sign in again" in memory; a send shows that
  message only while the mark is set. Signing in replaces the credential and clears the mark.
- [x] API keys: the account screen's Save writes the key with `credentials.modify(providerId, async () =>
  ({ type: 'api_key', key }))`, the `CredentialStore` contract's only write path; `models.login` ends in the same
  `modify`. The account screen does not change.
- [x] Sign-in single-flight lives only in the account hook. `ChatRuntime` is folded into the provider.
- [x] One error model: operations return their own errors to the screen that started them. The runtime keeps only
  "chats could not open" and harness reports.

Keep the app-written OAuth adapter and Swift loopback module, the manual-entry fallback when the callback receiver
cannot start, and `transport: 'sse'`.

### Web search and Markdown

Web search keeps showing search activity, sources and citation links, and the model sees the findings on later turns.

**Recorded on 2026-10-09** from the app's own archive on the owner's iPhone (one ChatGPT response: 4 searches, 83
results, 3 citations; sanitized copy in `docs/web-search-recording.json`):

| Question | Answer |
| --- | --- |
| Where completed searches arrive | `response.output_item.done` during the stream, with `action` (`queries`, `sources`) and `results`. `response.completed` has an empty `output`. |
| Shape of a result | `{ type: 'text_result', title, url, snippet }`. `open_page` calls carry a `url` and page-text results; `find_in_page` never appeared. |
| Where citations arrive | `response.output_text.annotation.added`, repeated in the message's `output_item.done`. |
| Citation markers in the text | None. The answer already contains one Markdown link `([domain](url))` per `url_citation` span. |
| Offsets | Unicode code points, end exclusive, per message item. Not needed for rendering. |
| Messages | A short "commentary" message, then the final answer; pi-ai stores them as separate text blocks. |
| ChatGPT sign-in | Results and sources come back. |
| Cited URLs | OpenAI appends `?utm_source=openai` to cited URLs. |

**WS-1: data side**

- [x] Keep the spread-based provider decorator; it is pi-ai's exported-code form for decorating a built provider.
  `createProvider` returns a plain object, so `withNativeWebSearch(openaiProvider())` spreads it and overrides only
  `stream`/`streamSimple`, preserving auth, catalog, `refreshModels`, `filterAllModels` and the `openai-decisions`
  classifiers. `azureStreams` and `opencode-headers.ts` wrap `ProviderStreams` when building a provider from parts;
  a built provider's original streams are not reachable, so rebuilding one from parts would lose the classifiers.
  Checked against pi-ai `models.ts` at the vendored revision.
  - `onPayload`: append `{ type: 'web_search' }` to `tools`, and `web_search_call.results` and
    `web_search_call.action.sources` to `include`, keeping what pi-ai set. Never add `reasoning.encrypted_content`.
  - `onProviderStreamEvent`, as the recording shows: `response.output_item.added` with a `web_search_call` item marks
    that call running; `response.output_item.done` with a `web_search_call` item is the completed call, with its
    `action` (`search` with `queries` and `sources`, or `open_page` with `url`) and its `results` (each
    `{ type: 'text_result', title, url, snippet }`); `response.output_text.annotation.added` with a `url_citation` is a
    citation. `response.completed` carries no output items; read nothing from it. Decode every field with small typed
    decoders, no casts.
  - Only requests bound to a chat get the tool; compaction requests don't.
- [x] Keep `bindings.ts`'s per-request correlation through the request's `AbortSignal`; the bound state is only the
  chat id and a way to write, and the `{ error }` scope variant goes with the budget machinery. Verified at the
  vendored revision: the generation hook's `context.abortSignal` is the stream options' `signal`
  (`scheduler.ts`, `generation.ts`).
- [x] The `beforeRequest` hook only binds, for every generation request: the decorator wraps only the OpenAI provider,
  which is single-API (`openai-responses`), so every bound request through it is an OpenAI Responses request;
  compaction runs a `CompactionTask` whose hooks never fire here, and other `Models` calls carry unbound signals. No
  `getTask`, no pinned-checkpoint read and no `as GenerationCheckpoint` cast (AGENTS.md forbids casts), no `prepared`
  return, and no `afterResponse`.
- [x] Each completed search call becomes one app entry, written with
  `conversation.submit({ type: 'write', entry, requestId: <the search item id> })` (README "Busy Conversations",
  example 20): `data` holds the action, `model` holds the call's results as one user message of readable text. No
  budgets or caps (AGENTS.md: library defaults); a provider context overflow takes pi-durable's own
  compact-and-retry path. Don't await it in the stream handler; pass a failure to the Harness's `onReport` unless the
  request was aborted, as pi-durable does with its own streaming commits (`src/harness/generation.ts`). The transcript
  hides this one entry kind; there are no change entries.
- [x] One small presentation document per chat, `history: 'latest', fork: 'current'`, keyed by `responseId`, holding
  each search call's status, the sources (each result's title and URL) and the cited URLs. pi-ai sets
  `AssistantMessage.responseId` from `response.created`, before any search event, and `onProviderStreamEvent` observes
  it before pi-ai processes it, so the keying works for the streaming partial too; a retried request gets a new
  response and a new key. Create the document with the chat in `createConversation({ init })`, as examples 06 and 29
  create a document they later read. Commit when a call starts, when it completes, and when the decorator's stream
  ends, stopped streams included. The chat projection reads only this document. Delete `ChatView`'s late-document
  attach — the whole `subscribeCommits`/`observe` path goes, because every document the view reads now exists from the
  creating commit — and the native rendering paths in `chat-projection.ts`: `nativeRows`, `appendNative`, `orphaned`,
  `nativeByResponse`, `currentNative`, `nativeInterrupted`, `nativeTimestamp` and `ChatState.native/nativeLive`. An
  assistant row's `webSearch` is the document's entry for `message.responseId`, the streaming partial included.
- [x] Delete what this replaces: `wrapper-stream.ts`, `normalization.ts`, `archive.ts`, `migration.ts`, `budget.ts`
  (with the Models proxy passed to `Harness.open`; pass the plain `models`), `edits.ts` (already dead code today),
  `lifecycle.ts`, `persistence.ts`, `evidence.ts`, the digest index and change entries, turn-origin capture, the
  `disabled*` fields, the pre-request work and `afterResponse` in `durable.ts`, the UUIDv7 timestamp parsing, the
  duplicated helpers and the test-only exports.

**WS-2: rendering**

- [ ] Citations are already Markdown links in the answer text, so render the text as it is. Delete `source-map.ts`,
  the compiler hooks and generated-text projection in `parse-markdown.ts`, `citedInlineRuns`, `inlineCitations`, the
  citation props and `noCitations`. The streaming repair keeps its virtual closers, but `restoreSource` goes with the
  source maps: re-parse the prepared text and filter the pending-link sentinel href (`https://streaming.invalid/`) by
  value, and give every run of the re-prepared suffix, not only autolinks, an index-based React key.
- [ ] The sources list keeps today's order, cited sources first and then the other results, read from the presentation
  document: the sources are the union of the calls' results and the cited URLs, and a citation matches its result
  ignoring the `utm_source=openai` query parameter.

Known limits: without source maps, the balancing `]` the streaming repair adds to an unclosed nested link label can
show briefly while a reply streams. No work for this.

On-device data: old chats' web-search records live in documents WS-1 replaces; clear app data.

### P1 Done when

- list, rename and delete behave as above on device;
- a long bash output can be read back from its spill file, and chats can't see each other's `/tmp`;
- no busy guards, caps or uncalled production APIs remain;
- on a device against a real host, `read`, `write`, `edit` and `bash` work;
- two chats in different directories on one machine share one daemon session;
- a credential or key change applies at the machine's next connection start;
- a real ChatGPT chat on device shows "Searching the web…", sources and inline citation links;
- a follow-up question uses the results;
- stopping mid-search leaves a coherent transcript and the sources found so far;
- typecheck, lint and `git diff --check` pass.

## P2: Product features

- [x] Sending while busy, as Claude Code does (`b7e4a68`; follow-up and steer on device pending):
  - A message sent while a response runs is queued as a follow-up (`whenBusy: 'followUp'`) and shown as a queued
    bubble from the view's `pi.inbox`. The composer no longer refuses to send while busy (today `sendMessage` guards
    on `busy` and `Composer` disables); the metadata commit and the `lastInput` follow already work for a queued
    submission.
  - The queued bubble's "Send as steer" option withdraws it (`submission.abort()`) and resubmits it with
    `whenBusy: 'steer'`; an `already_placed` answer means the follow-up was placed meanwhile, so it is left alone.
- [x] New-chat default: the most recently active chat's model and effort when its provider is connected, else the first
  connected provider's entry in `models.ts`.

**Done when:** follow-up, steer and the new-chat default behave as above on device; typecheck, lint and
`git diff --check` pass.

## Docs

- [x] Rewrite `README.md` to match the code (done in the README's own commit). Stale lines: :3 (new-chat default); :4 (exact-pins to 1.1.0; the
  packages are now vendored builds of main); :5, :59 and :84 (Android); :16 and :75 ("Open **Providers**"; the screen
  is Account); :19 (archiving); :25 ("Finish or stop pending work"; there are no busy guards); :41 (the deleted
  native-search test suite); :49 (the in-memory `/tmp` and the old `pi-workspaces.db` note); :61 and :74
  (`invalid_grant` removes the credential; it is now kept and marked expired); :98 (`chat-runtime.ts`), :100
  (`streaming-markdown.ts`) and :109 (`tools.ts`), which no longer exist; :35–45 after the web search rewrite.

## Later: Background keep-alive

Keep the app running while any agent works in the background, using a Live Activity plus background location, as
Termius does. Build it after the phases above.

- **Busy signal:** `harness.taskGraph()`, which lists every live task. Exclude tasks blocked by a missing definition
  (`harness.inspect()`), or keep-alive may never stop.
- **Live Activity:** use `expo-widgets` (SDK 58 `createLiveActivity`, config plugin) rather than a hand-written
  ActivityKit target. It creates an App Group; keep the database out of it.
- **Background location:** use expo-location's config-plugin flags with an expo-task-manager task and
  `startLocationUpdatesAsync(task)`.
- **Before relying on location:** compare iOS 26's `BGContinuedProcessingTask` (Apple's API for continuing user-started
  work; it would need a small custom Expo module), check App Review guideline 2.5.4, and measure battery impact.
- **Opt-in:** off by default, with a setting that explains the location use.

Open question before building: provider and SSH credentials are Keychain items with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`,
so SSH reconnects and token-refresh saves fail while the phone is locked. Choose `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`
(existing data: clear app data) or hold the admission in memory, which reverses P1's "no cached admission".

**Done when:** a long agent run, local or over SSH, finishes with the phone locked for 10 minutes. The Live Activity
shows progress and ends when the work does.
