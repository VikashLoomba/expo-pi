# Pi Chat on Expo / iOS

An on-device chat app built with Pi's **durable `Harness`**, Expo SQLite, and Pi's provider registry. Connect OpenAI with ChatGPT or an API key, or use Anthropic, Google, OpenRouter, or xAI with an API key. Continue independent conversations across app restarts, each with its own provider, model, and reasoning effort. A new chat uses the first connected provider in the catalog and that provider's first model with a supported reasoning setting.

The app exact-pins `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord` to **1.1.0**. The previous one-prompt Agent Core runner has been replaced by a shared durable session with separate conversations. [`@automatalabs/expo-pi`](packages/expo-pi/README.md) supplies the Metro transform and secure-random bridge needed to run Pi in Expo on iOS and Android.

## Run

```sh
pnpm install --frozen-lockfile
npx @expo/agent-cli dev --ios --local --dev-client --detach --wait-ready --clear
```

Use a development build for the app's OAuth integration. Rebuild an existing development client after adding `expo-sqlite` or changing native dependencies. If an older detached server is running, stop it with `npx @expo/agent-cli dev:stop`. Clear Metro's cache after upgrading Pi so the running app resolves the new packages.

1. Open **Providers**. In **OpenAI**, choose **Continue with ChatGPT** for the modern browser flow or **Use API key**. Each replaces the other authentication method for this provider.
2. Complete browser sign-in. On iOS, a local Swift Expo module receives Pi's localhost callback and the app closes the authentication browser automatically. If the listener or browser is unavailable, the same PKCE/state attempt can finish through **Open in browser** and the full callback URL field. See the [modern OAuth adapter](src/pi/openai-auth/README.md) for the callback lifecycle and validation boundaries.
3. Return to **Chats** and start a chat. It uses a connected provider; change the provider, model or effort in the chat's **Model settings**.
4. Use **Stop** to cancel a response. Rename or archive conversations from their chat actions; archived chats are hidden from the list, while their durable records remain stored.

Existing chats remain readable without a provider connection. Starting a chat, sending, or resuming model work requires credentials for a provider. Pi's `openai` OAuth provider has no device-code route in the installed `pi-ai` 1.1.0.

## Per-chat model settings

Tap the model in a conversation's header or choose **Model settings** in its chat options. Choose a provider, search its models, and select one of that model's supported reasoning levels. **Save** commits all three choices together; **Cancel** discards the draft. Changes apply to subsequent responses and keep the conversation history. Finish or stop pending work before changing its model.

The model catalog comes from the registered Pi `Models` instance. Display names and reasoning levels come from the SDK, including models with fixed reasoning or no ability to turn reasoning off. **Refresh models** asks registered dynamic providers to refresh their catalog; saving an API key refreshes it too. Saved choices that become unavailable remain visible and require an explicit replacement. Account-specific model availability is checked before admitting a message.

Settings are stored in Pi's existing conversation-scoped **`AgentDoc` (`pi.agent`)**, using its public `configure()` mutation in one durable transaction. They are projected from committed revisions through `useSyncExternalStore`, just like the transcript. No second preferences database, AsyncStorage copy, or custom schema migration is needed. Existing chats keep their agent settings, and omitted effort follows Pi's `off` default.

Open **Providers** to connect accounts or API keys. Credentials are saved separately from conversations in Expo SecureStore, one record per provider; ChatGPT sign-in and an API key are alternative credentials for `openai`. `src/pi/models.ts` is the provider-registration boundary: add a mobile-compatible SDK provider there to expose its catalog through the same settings UI. No provider or model union needs to be edited in chat state.

## Native OpenAI web search

The modern **OpenAI** provider makes Responses' hosted `web_search` tool available alongside local function tools. Pi and OpenAI decide when to call it. Search activity appears within the assistant response, with expandable queries/page actions, clickable inline citations, and a source list. Stopping a request keeps received search activity visible as interrupted. Model and account support are determined by OpenAI; other providers keep their existing behavior.

`withNativeWebSearch(openaiProvider())` decorates Pi's registered provider. Pi still owns authentication, HTTP/SSE transport, retries, response parsing, text streaming, and local tool execution. The wrapper composes the public `onPayload` and `onProviderStreamEvent` callbacks to add the hosted tool, request native results/sources/encrypted reasoning, and preserve the provider's structural events. A caller's payload callback receives the assembled native request and retains the final say over its contents.

The durable extension uses `GenerationTask.beforeRequest` to bind each generation's signal to its conversation and request identity. Native response envelopes, ordered output items, search results, annotations, and opaque reasoning state are stored in the conversation-scoped, rewindable `app.openai.responses` document. Commits finish before the corresponding normalized Pi events are forwarded. A separate latest-state document selects live activity; it does not copy in-flight state into a fork. Provider callbacks stay in memory and never enter serialized harness settings.

Run the native-search integration suite when upgrading Pi; it verifies that the generation hook and provider receive the same signal and that replay respects the SDK's context transformations.

Completed searches also become typed `SearchObservationEntry` records in that same transaction. Their `model` content contains attributed, readable source excerpts; their `data` contains provenance and completeness metadata. Pi-durable's canonical context now supplies the findings after reopening, across model/provider changes, and to its built-in compactor. The UI projects search activity and sources without presenting observations as human messages or assistant prose.

Pi owns native reasoning signatures, request conversion, and local tool pairing. The former raw-history input rewrite has been removed. Immutable context edits handle enrichment and logical-turn changes, and an idempotent migration backfills retained snippets only from valid active history. Deterministic evidence limits preserve complete raw results and report projection omissions; a generation capacity guard routes oversized canonical requests through Pi's normal overflow-compaction path.

## Persistent chats and lifecycle

Chats receive Pi's own `CodingTools` (`read`, `write`, `edit`, and `bash`), with Pi's default tool execution. Each chat has a private, persistent `/workspace`: a real directory in the app's documents (`workspaces/<id>`), accessed through `expo-file-system`. The app adds no size limits of its own; Pi's tools and just-bash apply their defaults. Edit cards show Pi's own diff. Bash runs just-bash's interpreted shell with text tools, jq and checksums; JavaScript, Python, network commands, gzip, links and chmod are not offered. Each command starts with fresh shell state and an empty in-memory `/tmp`. Workspace files from the earlier SQLite-backed workspace (`pi-workspaces.db`) are not carried over; that database is left in place.

One `SqliteStorage` instance backs the app's durable session and all conversations. The custom Expo driver opens **`pi-chats.db`** and supplies the asynchronous database interface expected by Pi's portable `SqliteStorage`. Pi owns the schema, migrations, records, document revisions, task checkpoints, and atomic commits. The adapter serializes native operations and transactions, rolls failed transactions back, and waits for admitted work before closing.

The UI reads pi-durable's own views and keeps no copy of them. The chat list reads one `app.chat` document per chat: its title, a preview of the last message sent, and when it was sent. It never reads transcripts, so opening the app costs the same however long the chats are. An open chat subscribes to its conversation view (`viewState()`), which carries the active entries together with `pi.live`, `pi.inbox` and `pi.agent` in one revision, and to `documentState()` for the app's own documents. Because the view holds only the active context, the open chat also reads its full history once with `conversation.entries()`, so messages from before a compaction stay visible. Subscriptions start when a screen shows the chat and end when it leaves. A compaction summary shows as "Earlier messages summarized", never as a user message.

The app opens the database once at launch and keeps it open, including in the background, until the app's root unmounts. After opening it calls `harness.resume()`, so work the last process left unfinished continues. Each request resolves its credentials when it starts. A recovered chat whose provider is signed out fails with a visible error and does not hold up other chats. Requests use SSE with pi-durable's default retry and timeout policy, so a request cut off by a transient network error, for example while iOS suspended the app, is retried. The app does not keep running work in the background; that is a separate, later feature. Completed requests with an existing request ID are not submitted again.

Streaming follows the bottom of the transcript until you drag to read earlier messages. Returning to the bottom or choosing **Scroll to latest message** resumes following. The scroll animation runs on the UI thread and respects the system's Reduce Motion setting. Markdown keeps completed blocks in place as the last block grows, and assistant/tool rows retain their identity when a partial becomes a saved message. The header and composer subscribe only to control-state changes. These presentation changes preserve Pi's existing 100 ms durable partial-checkpoint cadence.

**Credentials persist in Expo SecureStore** (iOS Keychain / Android Keystore), one record per provider: an API key, or for ChatGPT the access token, refresh token, expiry, issued client ID and scopes. They are restored on startup and never stored in the chat SQLite database. Pi refreshes OAuth tokens near expiry and saves the replacement before authenticating the request. System authentication-browser cookies are managed separately.

Signing in, saving an API key and signing out change only the credential store; open chats stay open and readable. After signing out, the next message for that provider asks you to connect it again. A failed credential deletion is reported and can be retried from Providers; a temporary network or Keychain error preserves the stored session. A token-endpoint `invalid_grant` removes the rejected credential and asks for sign-in again.

## Pi and Expo authentication

The app has one credential store and one OAuth adapter. `src/pi/models.ts` builds Pi's `Models` with `createModels()`, backed by `ProviderCredentialStore`, and registers:

- **OpenAI** (`openai`): Sign in with ChatGPT or an API key. The provider is wrapped for native web search, and only its `auth.oauth` is replaced by the app's Expo adapter in [`src/pi/openai-auth/`](src/pi/openai-auth/README.md), because Pi's own login flows import `node:http` and cannot run on Hermes.
- **Anthropic, Google, OpenRouter and xAI**: API keys.

Pi-ai's README marks `openai-codex` as legacy, superseded by Sign in with ChatGPT on `openai`. The app does not register it; chats saved with an `openai-codex` model show the model as unavailable until another is chosen in chat settings.

The adapter follows Pi's browser authorization-code + PKCE protocol with dynamic client registration. On iOS, a Swift-only Expo module ([`modules/pi-oauth-callback/`](modules/pi-oauth-callback/README.md)) receives the `http://127.0.0.1:1455/auth/callback` loopback redirect. If the port is busy or the browser does not return, the same attempt finishes by pasting the full callback URL; PKCE and state make a stolen callback unusable.

`Models.login()` persists credentials. `Models.getAuth()` and request paths refresh OAuth tokens under the store's per-provider lock, with Pi's own timeout and without the caller's cancellation, so a received token rotation is always saved. `ProviderCredentialStore` keeps one versioned SecureStore record per provider, serializes each provider's operations, retries saving a rotated token whose first write failed before the old token can be used again, and removes the credential when OpenAI rejects its refresh token (`invalid_grant`). The durable harness uses the same `Models` instance.

References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo SDK 58 SecureStore](https://docs.expo.dev/versions/v58.0.0/sdk/securestore/).

## Validation

```sh
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
npx @expo/agent-cli doctor
npx expo export --platform ios --platform android --source-maps --clear
```

At the user's request, the current Release build with modern OpenAI OAuth and native web search was installed and cold-launched on the physical iPhone 15 Pro. The Chats screen and existing saved history loaded from the bundled app with Metro unavailable.

Native integration, background/foreground behavior, and live authenticated ChatGPT requests are separate validation gates.

## Main files

- `src/app/index.tsx`: saved chat list, search, creation, and chat actions.
- `src/app/chat/[id].tsx`: conversation transcript, composer, streaming, tool output, and cancellation.
- `src/app/chat-settings/[id].tsx`: staged per-chat provider, model, and reasoning settings.
- `src/app/account.tsx`: provider API keys, ChatGPT sign-in, browser actions, connection retry, and disconnecting accounts.
- `src/chat/chat-provider.tsx`: shared Models instance, account state, and the hooks that subscribe a screen to a chat.
- `src/chat/chat-runtime.ts`: opens chat storage once, and sign-in, API keys and sign-out.
- `src/components/chat/transcript.tsx` and `src/hooks/use-transcript-scroll.ts`: transcript-only subscriptions and UI-thread following that yields to the reader.
- `src/components/chat/streaming-markdown.ts` and `message-content.tsx`: incremental Markdown parsing and stable rendered blocks.
- `src/pi/chat-service.ts`: durable Harness, the chat list from `app.chat` documents (`chat-metadata.ts`), sending and settings.
- `src/pi/chat-view.ts`: `ChatView`, one chat's conversation view and document subscriptions while it is shown.
- `src/pi/chat-projection.ts`: pure mapping from a chat's committed state to rows, controls and list summaries.
- `src/pi/native-web-search/`: OpenAI provider wrapper, native archive/replay, durable documents, and safe presentation projection.
- `src/components/chat/web-search.tsx`: native search activity and sources, with citation source maps in the existing Markdown renderer.
- `src/pi/model-catalog.ts`: SDK-derived provider/model choices, effort capabilities, and selection validation.
- `src/pi/models.ts`, `provider-credentials.ts` and `secure-storage.ts`: mobile provider registration and provider-scoped SecureStore persistence.
- `src/pi/storage/`: custom Expo `SqliteDatabase` adapter and portable `SqliteStorage` factory.
- `src/pi/workspace/`: each chat's workspace directory (`device-storage.ts`), the execution environment over it (`execution-env.ts`), the shell's view of it (`files.ts`), and Pi's coding tools (`tools.ts`).
- `src/pi/openai-auth/`: modern OpenAI `OAuthAuth` adapter, installation identity, issued-client token exchange, callback/browser coordination, and same-attempt manual fallback.
- `modules/pi-oauth-callback/`: Swift-only Expo Modules 2.0 loopback receiver using Apple Network; local module autolinking keeps native code outside generated projects.
- `packages/expo-pi/`: Metro compatibility transform and secure-random bridge; also usable with Pi's in-memory `Agent` API.
