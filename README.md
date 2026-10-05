# Pi Chat on Expo / iOS

An on-device chat app built with Pi's **durable `Harness`**, Expo SQLite, and Pi's provider registry. Connect OpenAI with ChatGPT or an API key, retain the separate legacy Codex connection, or use Anthropic, Google, OpenRouter, or xAI. Continue independent conversations across app restarts, each with its own provider, model, and reasoning effort. New chats initially use `gpt-6-sol` from the pinned Pi catalog; the `add_numbers` tool executes locally on the device.

The app exact-pins `@earendil-works/pi-ai`, `@earendil-works/pi-durable`, and `@earendil-works/chord` to **1.0.0**. The previous one-prompt Agent Core runner has been replaced by a shared durable session with separate conversations. [`@automatalabs/expo-pi`](packages/expo-pi/README.md) supplies the Metro transform and secure-random bridge needed to run Pi in Expo on iOS and Android.

## Run

```sh
pnpm install --frozen-lockfile
npx @expo/agent-cli dev --ios --local --dev-client --detach --wait-ready --clear
```

Use a development build for the app's OAuth integration. Rebuild an existing development client after adding `expo-sqlite` or changing native dependencies. If an older detached server is running, stop it with `npx @expo/agent-cli dev:stop`. Clear Metro's cache after upgrading Pi so the running app resolves the new packages.

1. Open **Providers**. In **OpenAI**, choose **Continue with ChatGPT** for the modern browser flow or **Use API key**. Each replaces the other authentication method for this provider.
2. Complete browser sign-in. On iOS, a local Swift Expo module receives Pi's localhost callback and the app closes the authentication browser automatically. If the listener or browser is unavailable, the same PKCE/state attempt can finish through **Open in browser** and the full callback URL field. See the [modern OAuth adapter](src/pi/openai-auth/README.md) for the callback lifecycle and validation boundaries.
3. For the existing device-code connection, use the separate **OpenAI Codex (legacy)** card. It requests and copies a one-time code; choose **Open sign-in page** and enter it. Keep the app in the foreground while it polls for approval. Modern and legacy connections can coexist.
4. Return to **Chats**, choose the connected provider in the chat's **Model settings**, and send a message. Asking it to add 19 and 23 exercises the on-device `add_numbers` tool.
5. Use **Stop** to cancel a response. Rename or archive conversations from their chat actions; archived chats are hidden from the list, while their durable records remain stored.

Existing chats remain readable without a provider connection. Sending or resuming model work requires credentials for the selected provider. Legacy Codex device-code login requires the account or workspace to permit it; see [OpenAI's device-code instructions](https://learn.chatgpt.com/docs/auth#login-on-headless-devices). Pi's modern `openai` OAuth provider has no device-code route in either the installed 1.0.0 or published 1.0.1 SDK checked on October 3, 2026.

## Per-chat model settings

Tap the model in a conversation's header or choose **Model settings** in its chat options. Choose a provider, search its models, and select one of that model's supported reasoning levels. **Save** commits all three choices together; **Cancel** discards the draft. Changes apply to subsequent responses and keep the conversation history. Finish or stop pending work before changing its model.

The model catalog comes from the registered Pi `Models` instance. Display names and reasoning levels come from the SDK, including models with fixed reasoning or no ability to turn reasoning off. **Refresh models** asks registered dynamic providers to refresh their catalog; saving an API key refreshes it too. Saved choices that become unavailable remain visible and require an explicit replacement. Account-specific model availability is checked before admitting a message.

Settings are stored in Pi's existing conversation-scoped **`AgentDoc` (`pi.agent`)**, using its public `configure()` mutation in one durable transaction. They are projected from committed revisions through `useSyncExternalStore`, just like the transcript. No second preferences database, AsyncStorage copy, or custom schema migration is needed. Existing chats keep their agent settings, and omitted effort follows Pi's `off` default.

Open **Providers** to connect accounts or API keys. Credentials are saved separately from conversations using Expo SecureStore on native platforms and session storage on web. Modern OpenAI credentials are stored under `openai`; the legacy ChatGPT credential retains its existing client-specific storage key under `openai-codex`. `src/pi/models.ts` is the provider-registration boundary: add a mobile-compatible SDK provider there to expose its catalog through the same settings UI. No provider or model union needs to be edited in chat state.

## Native OpenAI web search

The modern **OpenAI** provider makes Responses' hosted `web_search` tool available alongside local function tools. Pi and OpenAI decide when to call it. Search activity appears within the assistant response, with expandable queries/page actions, clickable inline citations, and a source list. Stopping a request keeps received search activity visible as interrupted. Model and account support are determined by OpenAI; the legacy Codex provider and other providers keep their existing behavior.

`withNativeWebSearch(openaiProvider())` decorates Pi's registered provider. Pi still owns authentication, HTTP/SSE transport, retries, response parsing, text streaming, and local tool execution. The wrapper composes the public `onPayload` and `onProviderStreamEvent` callbacks to add the hosted tool, request native results/sources/encrypted reasoning, and preserve the provider's structural events. A caller's payload callback receives the assembled native request and retains the final say over its contents.

The durable extension uses `GenerationTask.beforeRequest` to bind each generation's signal to its conversation and request identity. Native response envelopes, ordered output items, search results, annotations, and opaque reasoning state are stored in the conversation-scoped, rewindable `app.openai.responses` document. Commits finish before the corresponding normalized Pi events are forwarded. A separate latest-state document selects live activity; it does not copy in-flight state into a fork. Provider callbacks stay in memory and never enter serialized harness settings.

The signal binding and public transcript conversion behavior are verified against the pinned Pi 1.0.0 packages. Run the native-search integration suite when upgrading Pi; it verifies that the generation hook and provider receive the same signal and that replay respects the SDK's context transformations.

On subsequent turns, replay is limited to native responses represented in the current Pi context for the same provider and model, whose normalized content still matches the terminal content originally received from Pi. Context edits therefore keep their replacements even if they retain the original response ID. Pi's public transcript converter retains its tool-pairing and context rules; OpenAI's `toResponseInputItems` helper converts the saved native output into replayable input without changing the archive. A reset, compaction, or fork cannot reintroduce responses absent from that context. Encrypted reasoning stays opaque and is never exposed in presentation props. The UI remains a projection of durable documents rather than a second persisted transcript.

## Persistent chats and lifecycle

Chats receive local `read`, `write`, `edit`, and `bash` tools sharing a private, persistent `/workspace` stored in Expo SQLite. The file tools use Pi's SDK factories for paged text, complete UTF-8 writes, and targeted replacements; edit cards show bounded diffs and larger patches can persist as workspace files. Bash runs just-bash's interpreted shell with text tools, jq, checksums and gzip, with JavaScript/Python/network execution disabled. Shell state and `/tmp` reset each call. See the [workspace tools architecture, limits and maintenance guide](docs/bash-tool.md) for storage, edit limits, interruption, fork behavior and platform verification.

One `SqliteStorage` instance backs the app's durable session and all conversations. The custom Expo driver opens **`pi-chats.db`** and supplies the asynchronous database interface expected by Pi's portable `SqliteStorage`. Pi owns the schema, migrations, records, document revisions, task checkpoints, and atomic commits. The adapter serializes native operations and transactions, rolls failed transactions back, and waits for admitted work before closing.

The UI is a projection of committed Pi records, including streamed partials in `pi.live`; it does not maintain a separate persisted transcript. Conversation titles, history, tool results, archive state, and unfinished work survive closing and reopening the database. Reopened work remains paused until the runtime has authentication and asks the harness to resume. Completed requests with an existing request ID are not submitted again.

Streaming follows the bottom of the transcript until you drag to read earlier messages. Returning to the bottom or choosing **Scroll to latest message** resumes following. The scroll animation runs on the UI thread and respects the system's Reduce Motion setting. Markdown keeps completed blocks in place as the last block grows, and assistant/tool rows retain their identity when a partial becomes a saved message. The header and composer subscribe only to control-state changes. These presentation changes preserve Pi's existing 100 ms durable partial-checkpoint cadence.

When the app enters the background, the runtime requests a harness close and closes its storage. On foreground activation, it reopens the database and resumes unfinished work when credentials are available. This is foreground recovery of committed state; the app does **not** promise model execution while iOS or Android suspends it. A recovered unfinished generation can start a new provider request. Native suspend/resume and process-termination checks are tracked separately in the [verification record](docs/ios-compatibility.md).

**Native OAuth credentials persist in Expo SecureStore.** Records contain the access token, refresh token, expiry, and provider-specific metadata: the issued client ID and scopes for modern OpenAI, or the account ID for legacy Codex. Storage uses iOS Keychain / Android Keystore-backed storage with asynchronous reads and writes. Credentials are restored on startup; Pi refreshes tokens near expiry and commits any replacement refresh token before authenticating requests. Tokens are never stored in the chat SQLite database. The web adapter retains credentials in session storage for the current browser tab. System authentication-browser cookies are managed separately.

Signing out first stops the active scheduler, then removes saved credentials. Saved chats remain available. Failed credential deletion leaves requests paused and offers a retry; a temporary network or Keychain error preserves the stored session. A token-endpoint `invalid_grant` removes the rejected credential and asks for sign-in again. Authentication restoration and retry errors do not close readable chat history.

## Pi and Expo authentication

See the [modern OpenAI OAuth adapter](src/pi/openai-auth/README.md) and [legacy Codex OAuth adapter](src/pi/codex-auth/README.md) for their separate protocols, public APIs, and browser lifecycle requirements.

The app replaces only the registered providers' `login`, `refresh`, and `toAuth` methods through Pi's public `Provider.auth.oauth` interface. Expo supplies native browser presentation, PKCE, cryptography, and secure storage. Pi's `Models.login()` persists credentials; its request path serializes refresh through the credential-store lock. The durable harness receives that same `Models` instance and uses `settings.stream.transport = 'sse'`, zero provider retries, and a 60-second request timeout. Pi's provider catalogs and inference transports remain in use.

Modern OpenAI uses a local, Swift-only Expo Modules 2.0 callback receiver backed by Apple's Network framework. It binds only `127.0.0.1:1455` during the current sign-in; there is no desktop credential import or remote callback proxy. The authentication choices are:

- **OpenAI: modern Sign in with ChatGPT or API key.** The browser adapter follows Pi's dynamic public-client registration and authorization-code/PKCE protocol for the public Responses API. It retains Pi's HTTP loopback redirect and offers full-URL manual return when native browser capture does not complete. `LoginOptions.getDeviceId` identifies the installation; it does not enable device-code authorization. Pi 1.0.0 and 1.0.1 expose no modern device-code login route. See the [versioned SDK implementation](https://github.com/earendil-works/pi/blob/83692682f095528f8b71652ddacff7075e36e893/packages/ai/src/auth/oauth/openai-chatgpt.ts#L233).
- **OpenAI Codex (legacy): public client and device-code login.** The app implements the legacy device-code protocol originally adapted from Pi 0.87.1. OpenAI returns the authorization code and verifier through polling. Token exchange uses OpenAI's server-side device callback, which never calls back into the app. Closing the sign-in browser leaves approval pending; cancelling sign-in stops polling and dismisses the browser. The code expires after fifteen minutes.
- **Legacy registered mobile client: Expo authorization-code login.** If OpenAI issues your app a public client with Codex access and registers `piagent://auth/callback`, set `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` and restart Metro. Expo generates PKCE/state; the adapter validates the exact callback and rejects duplicate state/code parameters. The same client is used for exchange and refresh. This setting affects only `openai-codex`; it does not register a mobile redirect or configure modern OpenAI sign-in.

Automated protocol tests use synthetic credentials and do not establish live consent or model entitlement. The initial browser-only implementation could not capture Pi's HTTP loopback redirect. The native receiver now handles that redirect and returns it to the existing Pi/Expo OAuth flow. Browser failure, listener unavailability, and unsupported platforms retain manual callback entry. Live OpenAI consent, token exchange, and authenticated inference remain separate checks. The registered legacy mobile-client flow likewise requires an appropriately registered client. Legacy device-code browser presentation currently supports iOS. References: [Expo SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [Expo SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [Expo SDK 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/).

## Validation

```sh
npx @expo/agent-cli typecheck
npx @expo/agent-cli lint
pnpm test:compat
npx @expo/agent-cli doctor
npx expo export --platform ios --platform android --source-maps --clear
```

`test:compat` combines package compatibility, storage conformance, durable chat, native search, runtime lifecycle, catalog, credential, and Markdown tests. Durable-chat tests use the real Harness and SQLite storage with scripted model providers. Native-search tests use Pi's actual wrapped OpenAI provider and Responses parser with synthetic HTTP SSE, covering request composition, native preservation/replay, local function rounds, concurrency, cancellation, reopening, forks, and compaction. In addition to streaming, tools, cancellation, and recovery, the broader suite verifies per-chat settings persistence, provider switching with retained history, unsupported effort rejection, credential-specific model availability, and concurrent settings/send admission. Runtime and credential tests cover provider isolation, failed removal retries, safe replacement, and recovery when some providers are disconnected. OAuth responses and credentials are synthetic.

For native web-search verification with the development build foregrounded and connected to Metro:

```sh
node scripts/check-native-web-search.mjs
# Keep each stage visible for native UI inspection:
node scripts/check-native-web-search.mjs --hold-stage searching --hold-ms 30000
node scripts/check-native-web-search.mjs --hold-stage completed --hold-ms 30000
```

This probe uses the wrapped OpenAI provider, synthetic SSE at the fetch boundary, and a unique native SQLite database. It checks search activity before answer text, rendered citations/sources, persistence after reopening, and native replay on the next turn. It temporarily mounts its fixture chat and restores the UI afterward. It does not read account credentials or send authenticated model requests.

For an opt-in native integration check, keep a Hermes development build open in the foreground and connected to Metro, with the chat screen loaded, then run:

```sh
pnpm test:native
# For Android or a different Metro port:
pnpm test:native --platform android --port 8081
```

The command discovers the running app's Metro modules and uses a unique `pi-validation-*.db` SQLite database plus a scripted provider, without real credentials or model HTTP requests. It verifies the tool result **42** reaches the next model request, committed streaming output, title/history persistence after close/reopen, paused recovery while signed out, resumption of the same submission, durable cancellation after another reopen, and SSE transport. It also verifies settings remain independent across chats, survive SQLite reopening, and reach the selected provider's request with the saved effort. Its JSON report includes the validation database name and results; the command does not start or reload the app and is separate from `test:compat`.

For the streaming UI check, use an iOS Hermes development build connected to Metro on port 8081:

```sh
node scripts/check-native-streaming.mjs
# A 60-second run for checking native drag and return-to-latest behavior:
node scripts/check-native-streaming.mjs --manual
# Allow more time for device automation:
node scripts/check-native-streaming.mjs --manual --duration-seconds 120
```

The streaming probe temporarily opens its own scripted SQLite conversation, then restores its hooks and returns home. It reports growing-content following, completion at the bottom, stable message/React row identity, scroll commands, and JavaScript frame timing. The manual run requires native gestures and phase markers; follow the [streaming verification procedure](docs/ios-compatibility.md#streaming-presentation-and-repeatable-check). JavaScript frame timing measures JS responsiveness, not UI-thread frames per second.

Both default following and the manual native-gesture check passed on the iOS simulator with a scripted provider. During the reading-history interval, content grew by 1,220.67 points without moving the reader's position; tapping scroll-to-latest resumed following and finished at the measured bottom with the same assistant row.

At the user's request, the current Release build with modern OpenAI OAuth and native web search was installed and cold-launched on the physical iPhone 15 Pro. The Chats screen and existing saved history loaded from the bundled app with Metro unavailable. Feature integration checks use the simulator and synthetic provider responses; the physical-device check establishes installation and startup.

Native integration, background/foreground behavior, and live authenticated ChatGPT requests are separate validation gates. Current results and historical checks are recorded in [compatibility and verification notes](docs/ios-compatibility.md).

## Main files

- `src/app/index.tsx`: saved chat list, search, creation, and chat actions.
- `src/app/chat/[id].tsx`: conversation transcript, composer, streaming, tool output, and cancellation.
- `src/app/chat-settings/[id].tsx`: staged per-chat provider, model, and reasoning settings.
- `src/app/account.tsx`: provider API keys, ChatGPT sign-in, device code, browser actions, and disconnecting accounts.
- `src/chat/chat-provider.tsx`: shared Models instance, account state, and React subscriptions.
- `src/chat/chat-runtime.ts`: serialized foreground/background, storage, and account lifecycle.
- `src/components/chat/transcript.tsx` and `src/hooks/use-transcript-scroll.ts`: transcript-only subscriptions and UI-thread following that yields to the reader.
- `src/components/chat/streaming-markdown.ts` and `message-content.tsx`: incremental Markdown parsing and stable rendered blocks.
- `src/pi/chat-service.ts`: durable Harness, `add_numbers`, chat metadata, and committed-revision subscriptions.
- `src/pi/chat-projection.ts`: pure transcript, live-state, and chat-summary projections.
- `src/pi/native-web-search/`: OpenAI provider wrapper, native archive/replay, durable documents, and safe presentation projection.
- `src/components/chat/web-search.tsx`: native search activity and sources, with citation source maps in the existing Markdown renderer.
- `src/pi/model-catalog.ts`: SDK-derived provider/model choices, effort capabilities, and selection validation.
- `src/pi/models.ts` and `provider-credentials.ts`: mobile provider registration and provider-scoped credential persistence.
- `src/pi/storage/`: custom Expo `SqliteDatabase` adapter and portable `SqliteStorage` factory.
- `src/pi/codex-auth/`: native OAuth adapter, callback validation, token exchange, and device polling.
- `src/pi/openai-auth/`: modern OpenAI `OAuthAuth` adapter, installation identity, issued-client token exchange, callback/browser coordination, and same-attempt manual fallback.
- `modules/pi-oauth-callback/`: Swift-only Expo Modules 2.0 loopback receiver using Apple Network; local module autolinking keeps native code outside generated projects.
- `packages/expo-pi/`: Metro compatibility transform and secure-random bridge; also usable with Pi's in-memory `Agent` API.
