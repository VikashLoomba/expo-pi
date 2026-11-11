# InfiniChat

InfiniChat is an AI agent with one chat that never ends: Victor Taelin's
[UniiChat](https://github.com/VictorTaelin/UniiChat) design (a memory tree of one-line summaries the agent zooms
into) built on pi's durable `Harness`. One device holds the conversation, the iPhone itself or a machine running the
server, and every app shows it live. Both apps also keep ordinary chats of their own, each with its own provider,
model, reasoning effort and execution environment.

| Part | Where | What it is |
| --- | --- | --- |
| iPhone app | `apps/mobile` | Expo and React Native, iOS only. Holds InfiniChat itself or follows a machine. |
| Mac app | `apps/mac` | Electrobun: a Bun main process and React DOM screens. A client of the Mac's own server. |
| Shared code | `packages/infinichat` | The agent core, both apps' services and views, the clients of a server. |
| Server | `packages/infinichat-server` | What a machine runs to hold InfiniChat; a Chord host with plugins and MCP. |
| SSH library | `packages/react-native-ssh` | The phone's SSH engine (Rust, C FFI, Nitro module). |

pi's packages (`pi-durable`, `pi-ai`, `chord`, `pi-env` and the rest) take one version from the `catalog` in
`pnpm-workspace.yaml`. [`AGENTS.md`](AGENTS.md) holds the rules for working in this repository.
[`babel-plugins/pi-compat.js`](apps/mobile/babel-plugins/pi-compat.js) makes pi's published modules bundle and run on
Hermes, and `src/pi/random-values.ts` installs `crypto.getRandomValues` from expo-crypto at startup.

## Run

The app is in `apps/mobile`, a pnpm workspace in Expo's monorepo layout; `src/` and the other app paths in this README
are relative to it. Install from the repository root, then run the app's commands from `apps/mobile`:

```sh
pnpm install --frozen-lockfile
cd apps/mobile
npx @expo/agent-cli dev --ios --local --dev-client --detach --wait-ready --clear
```

Use a development build for the app's OAuth integration. Rebuild an existing development client after changing native dependencies. Clear Metro's cache after upgrading Pi so the running app resolves the new packages.

1. Open **Account**. In **OpenAI**, choose **Continue with ChatGPT** for the browser flow or **Use API key**. Each replaces the other authentication method for this provider.
2. Complete browser sign-in. On iOS, a local Swift Expo module receives Pi's localhost callback and the app closes the authentication browser automatically. If the listener or browser is unavailable, the same PKCE/state attempt can finish through **Open in browser** and the full callback URL field. See the [modern OAuth adapter](apps/mobile/src/pi/openai-auth/README.md) for the callback lifecycle and validation boundaries.
3. Return to **Chats** and start a chat. It uses a connected provider; change the provider, model or effort in the chat's **Model settings**.
4. While a response runs, **Stop** cancels it; sending another message queues it as a follow-up, shown as a queued bubble. The bubble's **Send as steer** action withdraws it and resubmits it as a steer, which joins the running work instead of waiting for it to finish.
5. Rename or delete conversations from their chat options. Delete stops the chat's work, marks it deleted, and removes its workspace directories.

Existing chats remain readable without a provider connection. Starting a chat, sending, or resuming model work requires credentials for a provider. Pi's `openai` OAuth provider has no device-code route in the installed `pi-ai`.

### The Mac app and the server

Run the Mac app from `apps/mac` with `hutch run dev` (Hutch drives Electrobun); [`docs/mac-app`](docs/mac-app/README.md)
has its design and release steps. The apps set the server up on a machine that has none, and it updates itself from
its `server/v<version>` GitHub releases; `pnpm release` in `packages/infinichat-server` cuts one. See
[server plugins, MCP and release](docs/server-plugins.md).

The sections below describe the iPhone app's ordinary chats; their paths are relative to `apps/mobile`.


## Per-chat model settings

Tap the model in a conversation's header or choose **Model settings** in its chat options. Choose a provider, search its models, and select one of that model's supported reasoning levels. **Save** commits all three choices together; **Cancel** discards the draft. Changes apply from the next request or tool call and keep the conversation history; work already running keeps what it resolved, as in pi-durable.

The model catalog comes from the registered Pi `Models` instance. Display names and reasoning levels come from the SDK, including models with fixed reasoning or no ability to turn reasoning off. **Refresh models** asks registered dynamic providers to refresh their catalog; saving an API key refreshes it too. Saved choices that become unavailable remain visible and require an explicit replacement. Account-specific model availability is checked before admitting a message.

Settings are stored in Pi's existing conversation-scoped **`AgentDoc` (`pi.agent`)**, using its public `configure()` mutation in one durable transaction. They are projected from committed revisions through `useSyncExternalStore`, just like the transcript. No second preferences database, AsyncStorage copy, or custom schema migration is needed. Existing chats keep their agent settings, and omitted effort follows Pi's `off` default.

Open **Account** to connect accounts or API keys. Credentials are saved separately from conversations in Expo SecureStore, one record per provider; ChatGPT sign-in and an API key are alternative credentials for `openai`. `src/pi/models.ts` is the provider-registration boundary: add a mobile-compatible SDK provider there to expose its catalog through the same settings UI. No provider or model union needs to be edited in chat state.

## Native OpenAI web search

The modern **OpenAI** provider makes Responses' hosted `web_search` tool available alongside local function tools. Pi and OpenAI decide when to call it. Search activity appears within the assistant response while it runs and after, with expandable queries/page actions, citations as the Markdown links the model already writes, and a source list with cited pages first. Stopping a request keeps received search activity visible as interrupted, and the model sees the completed searches' findings on later turns. Model and account support are determined by OpenAI; other providers keep their existing behavior.

`withNativeWebSearch(openaiProvider())` decorates Pi's registered provider, preserving its authentication, HTTP/SSE transport, retries, response parsing, text streaming, and local tool execution. The decorator composes the public `onPayload` and `onProviderStreamEvent` callbacks: the payload gains the hosted tool and the two web-search `include` entries (pi-ai's own `include` for active reasoning is kept), and raw stream events are read with small typed decoders. Only requests bound to a chat get the tool: a `GenerationTask.beforeRequest` hook binds the request's own cancellation signal to its conversation, and compaction and other `Models` calls carry unbound signals.

Each completed search call becomes one durable write entry, admitted with the search item's id so a replay can never duplicate it, and placed at the next turn boundary; its results reach the model as one readable message. A small presentation document per chat, created in `createConversation`'s `init` and keyed by the response's `responseId`, holds each call's status, the sources, and the cited URLs. The chat projection reads only this document. Commits are fire-and-forget, with failures reported through the Harness's `onReport`, as pi-durable reports its own streaming commits.

## Images

The attach control in the composer offers **Take Photo** and **Choose Photos**. Each photo is fitted to the chat model's image limits (`inputLimits.images`, or pi-durable's defaults of 2000x2000 pixels and 4.5 MB of base64) with `expo-image-manipulator`: decoded no larger than the limits, saved as JPEG at the model's quality, and shrunk while it is still over the byte limit. The message is sent as pi-ai `UserMessage` content with text and image parts, so the photos are saved in the conversation and shown in the sent bubble. A model without image input disables the control. When the `read` tool reads an image file, pi-durable returns one image block, which the tool card shows next to its diagnostics text. `read` runs with an app image processor (`createCodingTools({ images })`) built on `expo-image-manipulator`, so a file over the model's limits is turned upright, shrunk and re-encoded as JPEG rather than refused; the same function fits attached photos.

## Remote execution

Each chat can run its tools on a remote machine over SSH instead of the on-device workspace. Add machines in **Remote machines**: the app tests the connection, shows the server's host-key fingerprint for out-of-band comparison, and provisions the pi-env daemon automatically (verified by SHA-256, uploaded once per daemon version). SSH passwords and private keys live in the Keychain; host metadata lives in app settings storage. A chat's remote working directory is optional — blank runs in the account's home directory, and **Choose a folder** browses the machine one folder at a time in a native list, with a search that runs `find` a few levels below the shown folder, so a path never has to be remembered. One SSH connection per machine is shared by every chat and working directory on it, and a credential or host-key change applies at the machine's next connection start. The error copy points at Tailscale for connectivity, but any reachable SSH host works.

## Server plugins and MCP

When InfiniChat runs on a server, `/reload-plugins` reloads the tools plugin (code mode and the MCP servers of
`~/.infinichat/mcp.json`) and the user's plugins with Chord's hot reload, without restarting the conversation: added
servers connect, changed ones reconnect, removed ones close, and the others stay connected. See
[server plugins, MCP and release](docs/server-plugins.md) for configuration, failure handling and the upstream
patterns.

## Persistent chats and lifecycle

Chats receive Pi's own `CodingTools` (`read`, `write`, `edit`, and `bash`), with Pi's default tool execution. Each chat has a private, persistent `/workspace`: a real directory in the app's documents (`workspaces/<id>`), accessed through `expo-file-system`. Each workspace also has its own temporary directory under the system cache, exposed as `/tmp`, which nothing deletes and the system may purge. Long bash output spills to a `/tmp` file once it passes Pi's thresholds, including partial output on abort or timeout, and can be read back with the file tools. Bash runs just-bash's interpreted shell with text tools, jq and checksums; JavaScript, Python, network commands, gzip, links and chmod are not offered.

One `SqliteStorage` instance backs the app's durable session and all conversations. The custom Expo driver opens **`pi-chats.db`** and supplies the asynchronous database interface expected by Pi's portable `SqliteStorage`. Pi owns the schema, migrations, records, document revisions, task checkpoints, and atomic commits. The adapter serializes native operations and transactions, rolls failed transactions back, and waits for admitted work before closing.

The UI reads pi-durable's own views and keeps no copy of them. The chat list reads one `app.chat` document per chat: its title, a preview of the last message sent, and when it was sent. It never reads transcripts, so opening the app costs the same however long the chats are. An open chat watches its conversation view (`conversation.watch()`), which carries a window of the newest entries together with `pi.live`, `pi.inbox` and `pi.agent` in one revision, and the app's own documents (`watchDoc()`), which all exist from the creating commit. Pi's `ConversationTranscript` keeps what the chat has shown beyond the window: the transcript opens on its newest messages, and a row at its top loads the page before them as you scroll up to it, as one in its middle loads messages a reconnect missed. Watches start when a screen shows the chat and stop when it leaves; the transcript resumes after the newest message it holds. A compaction summary shows as "Earlier messages summarized", never as a user message.

While Pi compacts, the transcript shows **Summarizing earlier messages…**, including background summaries.
The latest compaction failure remains visible until Pi produces a summary. When a run ends without an answer (a
model error, a stop, the app quitting while the model answered, a crash loop), the chat says why above the composer,
from `pi.live.runFailure`, and offers **Continue**: Pi's continue submission runs the model again on the context as
it is, without a new message. These are projections of `pi.live`; the app adds no compaction policy, retries, or
failure-reset state.

The app opens the database once at launch and keeps it open, including in the background, until the app's root unmounts. After opening it calls `harness.resume()`, so work the last process left unfinished continues. Each request resolves its credentials when it starts. A recovered chat whose provider is signed out fails with a visible error and does not hold up other chats. Requests use SSE with pi-durable's default retry and timeout policy, so a request cut off by a transient network error, for example while iOS suspended the app, is retried. A storage error ends the Harness (pi-durable's `SessionFailed` semantics): it is reported once, and the app closes and reopens the session to recover. Completed requests with an existing request ID are not submitted again.

Streaming follows the bottom of the transcript until you drag to read earlier messages. Returning to the bottom or choosing **Scroll to latest message** resumes following. The scroll animation runs on the UI thread and respects the system's Reduce Motion setting. Markdown keeps completed blocks in place as the last block grows, and assistant/tool rows retain their identity when a partial becomes a saved message. The header and composer subscribe only to control-state changes. These presentation changes preserve Pi's existing 100 ms durable partial-checkpoint cadence.

**Credentials persist in Expo SecureStore** (iOS Keychain), one record per provider: an API key, or for ChatGPT the access token, refresh token, expiry, issued client ID and scopes. They are restored on startup and never stored in the chat SQLite database. Pi refreshes OAuth tokens near expiry and saves the replacement before authenticating the request. System authentication-browser cookies are managed separately.

Signing in, saving an API key and signing out change only the credential store; open chats stay open and readable. After signing out, the next message for that provider asks you to connect it again. A failed credential deletion is reported and can be retried from Account; a temporary network or Keychain error preserves the stored session. A token-endpoint `invalid_grant` keeps the credential (pi-ai's documented behavior: re-login fixes it) and marks the provider "Session expired — sign in again" until a new sign-in replaces it.

## Pi and Expo authentication

The app has one credential store and one OAuth adapter. `src/pi/models.ts` builds Pi's `Models` with `createModels()`, backed by `ProviderCredentialStore`, and registers:

- **OpenAI** (`openai`): Sign in with ChatGPT or an API key. The provider is wrapped for native web search, and only its `auth.oauth` is replaced by the app's Expo adapter in [`src/pi/openai-auth/`](apps/mobile/src/pi/openai-auth/README.md), because Pi's own login flows import `node:http` and cannot run on Hermes.
- **Anthropic, Google, OpenRouter and xAI**: API keys.

Pi-ai's README marks `openai-codex` as legacy, superseded by Sign in with ChatGPT on `openai`. The app does not register it; chats saved with an `openai-codex` model show the model as unavailable until another is chosen in chat settings.

The adapter follows Pi's browser authorization-code + PKCE protocol with dynamic client registration. On iOS, a Swift-only Expo module ([`modules/pi-oauth-callback/`](apps/mobile/modules/pi-oauth-callback/README.md)) receives the `http://127.0.0.1:1455/auth/callback` loopback redirect. If the port is busy or the browser does not return, the same attempt finishes by pasting the full callback URL; PKCE and state make a stolen callback unusable.

`Models.login()` persists credentials. `Models.getAuth()` and request paths refresh OAuth tokens under the store's per-provider lock, with Pi's own timeout and without the caller's cancellation, so a received token rotation is always saved. `ProviderCredentialStore` keeps one versioned SecureStore record per provider, serializes each provider's operations, and retries saving a rotated token whose first write failed before the old token can be used again. The durable harness uses the same `Models` instance.

References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo SDK 58 SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

## Validation

```sh
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
npx @expo/agent-cli doctor
npx expo export --platform ios --source-maps --clear
```

## Main files

- `packages/infinichat/src/pi/infinichat/`: the agent core. The memory tree and its views (`memory.ts`), the summary
  builds (`summary.ts`), the turn coordinator (`app.ts`), subagents (`agents.ts`), scheduled tasks (`schedule.ts`),
  the memory and device tools (`tools.ts`, `device-tools.ts`) and the prompt (`prompt.ts`).
- `packages/infinichat/src/pi/infinichat-service.ts` and `infinichat-view.ts`: what a screen sends to and reads from
  the conversation. `pi/infinichat-remote/`: the client of a machine's server, its install, and moving the
  conversation between devices.
- `packages/infinichat/src/pi/chat-service.ts`, `chat-view.ts` and `chat-projection.ts`: ordinary chats.
  `pi/native-web-search/`: OpenAI's hosted web search as a provider decorator. `node/`: the Node side for the server
  and the Mac app.
- `packages/infinichat-server/src/`: `main.ts` and `conversation.ts` (holding the conversation), `facet.ts` (what
  clients call), `plugins.ts` and `mcp-*.ts` (plugins, code mode and MCP), `update.ts` (self-update).
- `apps/mobile/src/app/`: the routes. `(tabs)/(infinichat)/` is the InfiniChat tab, `(tabs)/chats/` the ordinary
  chats, with `infinichat-settings/`, `infinichat-schedule/`, `remote-hosts/` and `account.tsx` beside them.
- `apps/mobile/src/chat/chat-provider.tsx`: the shared Models instance, account state and the services' lifecycle.
- `apps/mobile/src/pi/`: `storage/` (the Expo `SqliteDatabase` adapter), `workspace/` (the on-device execution
  environment), `execution/remote/` (the pi-env daemon client over SSH), `openai-auth/` (the OpenAI sign-in adapter).
- `apps/mobile/src/keep-alive/`: keeps on-device work running while the phone is locked.
- `apps/mobile/modules/pi-oauth-callback/`: the Swift loopback receiver for sign-in callbacks.
- `apps/mac/src/main/`: the Mac's main process. `src/view/`: its screens. `src/contract.ts`: what the two exchange.
