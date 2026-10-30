# Piece 6: Ordinary chats

## Goal

The ordinary chat service moves into the package, so the Mac app can have its own ordinary chats, in its own
database, as the phone has its own (owner decision, 2026-10-26). The iPhone passes in what is host-specific. Nothing
changes on the phone. This piece needs only pieces 1 and 2, so it can come right after them.

## Starts from

- `src/pi/chat-service.ts` (403 lines) has the same shape as `InfiniChatService`. It imports pi packages and files
  piece 2 already moves (`chat-view`, `chat-projection`, `chat-metadata`, `model-catalog`, `model-auth`, `user-input`,
  `workspace/document`, `execution/document`, `native-web-search/durable`), plus five host-specific imports:

  | Import | Used for | Where |
  | --- | --- | --- |
  | `createExpoImages` (`images.ts`: expo-file-system, expo-image-manipulator) | `createCodingTools({ images })` | `:87` |
  | `WorkspaceExecutionEnv` (`workspace/execution-env.ts`: just-bash) | A chat's local environment | `:109` |
  | `Workspaces` (`workspace/storage.ts`, types only) | The local environment, and removing a deleted chat's workspace | `:62`, `:109`, `:316` |
  | `RemoteExecution` (`execution/remote/owner.ts`, type only; react-native-ssh behind it) | A chat on a configured machine | `:102` |
  | `chatTasks`, `KeepAliveController` (`keep-alive/controller.ts`, which imports `expo-location`) | Counting the chats' live work | `:131` |

- The Harness's `env` already follows pi's sandbox-per-conversation example (`chat-service.ts:100-110`, upstream
  `packages/durable/test/examples/29-sandbox-per-conversation.ts`): each tool call reads the chat's committed target
  and builds an environment for it. Only the builders are host-specific.
- `native-web-search/provider.ts` imports only pi-ai and files piece 2 moves, so it can move too.
- The phone's `src/pi/models.ts` and the server's `server/models.ts` register the same providers. The phone adds its
  native OpenAI sign-in (`openai-auth/index.ts`, native browser) and `withNativeWebSearch`.

## Builds

### `DurableChatService` takes its host-specific parts

```ts
static async open(options: {
  storage: Storage; models: Models; now?: () => number;
  /** Prepares photos for `read` (pi-durable "Images"). */
  images: ImageProcessor;
  /** A chat's own environment on this device, and removing it with the chat; none, and tools fail as today. */
  local?: { environment(workspaceId: string, cwd: string | undefined): ExecutionEnv; remove(workspaceId: string): void };
  /** A chat on a configured machine. */
  machines: { environment(machineId: string, cwd: string | undefined): Promise<ExecutionEnv> };
  /** Counts live work while open; returns its detach. */
  observe?: (harness: Harness) => () => void;
  newChat?: NewChatDefaults; authError?: (providerId: string) => string | undefined;
  onClosed?: (end: SessionEnd) => void;
}): Promise<DurableChatService>
```

| Input | iPhone | Mac |
| --- | --- | --- |
| `images` | `createExpoImages()` | pi-durable's Photon processor, as `server/devices.ts` builds it |
| `local` | `WorkspaceExecutionEnv` over the device's workspaces | A folder per chat with `NodeExecutionEnv`, as upstream's `29-sandbox-per-conversation.ts` does ("Here a sandbox is a directory"); tools run real commands there |
| `machines` | `owner.ts`'s `environment` | pi-env `RemoteExecutionEnv`, through the `node` subpath's machines owner (piece 5) |
| `observe` | `keepAlive.observe(harness, chatTasks)` | None: a Mac doesn't suspend work |
| `storage` | `openExpoSqliteStorage('pi-chats.db')` | `openNodeSqliteStorage` |

`chatTasks` and `infiniChatTasks` (`keep-alive/controller.ts:21`, `:30`) are pure predicates over a task. Move them
into the package next to the services they describe; the keep-alive controller imports them back.

### Also moving

- `native-web-search/provider.ts` (`withNativeWebSearch`).
- One `registerChatProviders(models)` for the provider list that `src/pi/models.ts` and `server/models.ts` both repeat
  today, so a provider added for the phone also reaches the server's and the Mac's catalogs. The phone and the Node
  side keep their own credential stores and sign-in flows.

### What stays in the iOS app

`images.ts`, `workspace/{execution-env,device-storage,storage,files}.ts`, `execution/remote/*`, `keep-alive/*`,
`openai-auth/{browser,installation,index}.ts`, `models.ts`, and the provider wiring.

## Ownership and lifetime

Unchanged on the phone. The provider still creates the service, the keep-alive controller and the remote owner, and
closes them in today's order. The service borrows `machines` and `local`, and calls `observe`'s detach when it closes.

## Deviations (need approval)

None. Taking environment builders follows upstream's `29-sandbox-per-conversation.ts`, and nothing users see
changes.

## Size

`chat-service.ts` moves with about 20 lines changed at its seams, plus the two predicates and the web search provider.
The phone's wiring grows by about as much.

## Checks

- Lint, typecheck, server typecheck (unaffected).
- On the iPhone Release install:
  - A chat in the phone's workspace: a tool call reads and writes a file.
  - A chat on vikash-system: a tool call runs there.
  - A photo in a chat: `read` prepares it.
  - Web search with an OpenAI model: the sources show.
  - The keep-alive Live Activity appears while a chat works with the app in the background.
  - Deleting a chat removes its workspace.

## Not in this piece

The Mac app's chat screens. Sharing ordinary chats between devices is not planned: each device keeps its own.

## As built

From `af7c4a7`, with pi 1.4.0 (the latest on npm on 2026-10-26), Expo 58.0.17 and React Native 0.88.0; one commit, since
the doc names no steps. `git` records both moves as renames. What differs from the plan:

- **The server bundle changes,** because `createServerModels` now calls `registerChatProviders` (in the new
  `pi/chat-providers.ts`): 8,353,308 bytes, SHA-256 `ae0114c2…37e862`, so the phone reinstalls the server on each
  machine at its next connect. esbuild also keeps `infiniChatTasks`'s unused `Set` in it.
- **The phone registers the shared list, then replaces its sign-ins** with `setProvider`, which keeps a provider's
  place (pi-ai `MutableModels`): API keys only, and OpenAI with its native sign-in and web search. A probe found the
  same providers, order and auth as before.
- **The keep-alive controller imports neither predicate:** it never called them. It keeps `ChatOfTask`; the provider
  imports `chatTasks` from `chat-service.ts`, and `infinichat-phone.ts` imports `infiniChatTasks` from
  `infinichat-service.ts`.

## Later (2026-10-30): web search in InfiniChat and the Mac's chats

The owner found that an OpenAI model in InfiniChat never searched the web. It never had: a request gets OpenAI's
hosted `web_search` tool only when the provider carries `withNativeWebSearch` and a Harness's bridge binds the
request's signal (`native-web-search/durable.ts`). Only the chat service installed the bridge, and
`createServerModels` left the decorator out (`docs/server-harness-toggle/01-core-on-node.md`), so neither
InfiniChat's server nor the Mac's own chats, which use the same models, ever searched.

- `registerChatProviders` registers OpenAI as `withNativeWebSearch(openaiProvider())` on every host, so
  `createServerModels` carries it as the phone's `createChatModels` did; the Mac's chats search from it, since their
  service already installs the bridge. The phone now replaces only the sign-ins of the providers it registered.
- `openOptChat` takes the host's `extensions`; `InfiniChatService` installs the bridge through it and attaches it
  after the Harness opens, as `chat-service.ts` does. Summaries call `completeSimple` with an unbound signal, so
  they never search, as UniiChat's compactions offer no tools.
- `InfiniChatView` reads `SearchPresentationsDoc`, so the projection shows the searches and sources the chats show;
  both apps draw them, folded into the turn's steps. The service creates the document in a commit right after it
  opens: pi-durable's `documentState` resolves `undefined` for a document that doesn't exist yet
  (`session/session.js:666-668`), and the server's view stays attached for as long as the server runs, so the first
  build, which left the document to the bridge's first search, showed no search at all (owner's test, 2026-10-30).
  A chat creates its document in its creating commit for the same reason (`chat-service.ts`).
- **Memory logs each search** (owner, 2026-10-30, over keeping the reply only): `projectEntries` turns a
  `SearchObservationEntry` into a `tool` line, `web_search` with the action, and an `echo` with the results the
  model read, as it logs a function call and its result. pi-durable places a write with `model` at the next
  boundary (README "Busy Conversations"), so the search follows the reply that made it.

Size: about 30 lines of code, against the chat service's 3 lines for the bridge and the chat view's 10 for the
document.

## Later (2026-10-30): the model lists from pi.dev

The owner found OpenAI's list out of date. Each provider's list is the catalog pi-ai generates from models.dev when it
is released (`dist/providers/data/<id>.json`), and none of the six is dynamic in pi-ai 1.4.0 (README "Dynamic
Providers": "Static built-in providers are no-ops for `refresh()`"), so every Refresh models did nothing and the
server's catalog was fixed. pi 1.4.0 (2026-10-21) is the latest release; GPT-6.1 Terra came out on 2026-10-26. pi's own
agent overlays the catalog pi.dev publishes per provider and pi version (coding-agent
`src/core/remote-catalog-provider.ts`, `withRemoteCatalog`, the same at v1.4.0 and on main); pi-ai has the seams
(`refreshModels`, `context.publish`) but not the fetch. On 2026-10-30 pi.dev added `gpt-6.1-terra`, `chat-latest` and
`gpt-5.6-cyber` to OpenAI's 42, one Google model and nine OpenRouter ones; Anthropic, xAI and DeepSeek matched.

- `pi/pi-catalog.ts`'s `withPiCatalog` makes a provider dynamic as `withRemoteCatalog` does: its `refreshModels` reads
  `pi.dev/api/models/providers/<id>?types=chat&pi-version=<pi-ai's>` (the protocol's explicit version, so no
  User-Agent is needed), keeps the chat entries, and overlays them by id on pi-ai's. Entries are checked as pi-ai's
  Radius provider checks its gateway's (`isRadiusGatewayModel`), with no cast. Each request waits at most pi's 4 s.
- **In memory only** (owner: fetch it when needed rather than save a file): pi-ai's default store is in memory
  (`dist/models.js:48`), so each start fetches again. The server awaits `models.refresh()` before InfiniChat opens, so
  work it resumes finds a model pi-ai doesn't ship; the phone fetches at launch and after a sign-in, the Mac's account
  when it opens. pi-ai refreshes only a provider with a credential, so the others keep pi-ai's list.
- The contract gains `refreshCatalog` (an added method keeps the version, chord `docs/guide.md:148`); the server
  replaces `catalog` with it, and the phone's InfiniChat settings call it, where they refreshed the phone's own list.
- Deviations from the agent's wrapper: no comparison of pi.dev's Last-Modified with the shipped catalog's date, whose
  only source, `providers/all`, would bring every provider's catalog into the phone's bundle; no retry; only chat
  models. A fetch that fails keeps the models the provider had.

Checked on this Mac with Bun against the package: the server's models went from 42 OpenAI models to 45 in 371 ms,
`getModel('openai', 'gpt-6.1-terra')` resolved, and Anthropic without a credential kept its 17. Server bundle,
with the search document fix: 8,383,970 bytes, SHA-256 `9612d0d8…c02212`.
