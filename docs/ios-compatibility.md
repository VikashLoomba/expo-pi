# Pi / Expo native compatibility verification

## Expo patch update and standalone iPhone installation — October 4, 2026

Used Expo Doctor to identify SDK-compatible patch updates, then applied them through `npx @expo/agent-cli install --fix`. Expo is now **58.0.3**, expo-sqlite **58.0.9**, and expo-router **58.0.13**. The other recommended updates were `@expo/metro-runtime`, `@expo/ui`, `expo-auth-session`, `expo-dev-client`, `expo-font`, `expo-image`, `expo-splash-screen`, `expo-symbols`, and `expo-web-browser`. The local compatibility package's development Expo dependency was also updated to 58.0.3 through Agent CLI, removing duplicate native dependency installations. Its peer range remains compatible with SDK 58. Native project synchronization used Agent CLI prebuild; no generated native files were hand-edited.

The published SQLite patch leaves JavaScript APIs, declarations, the browser VFS/WASM and vendored SQLite unchanged. It fixes native statement cleanup and failed-close handling, so the rebuilt native app receives the fix without an app API or schema migration. Existing empty-BLOB handling and browser ownership protections remain required. The related Expo core/JSI changes do not require an application API migration.

| Upgrade validation gate | Result |
| --- | --- |
| Expo Doctor | **20/20 passed**; `.expo/device-upgrade-doctor-final.json` |
| SDK dependency check | Up to date; `.expo/device-upgrade-install-check.json` |
| Static checks | Agent CLI lint and typecheck passed with zero diagnostics; `.expo/device-upgrade-{lint.log,typecheck.json}` |
| Compatibility/application tests | **337 passed**: 37 compatibility-package and 300 application tests; `.expo/device-upgrade-tests.log` |
| Android and web production exports | Passed; `.expo/device-upgrade-export.log`, output `.expo/device-upgrade-export/`. Android device runtime was not exercised. |
| iPhone Release build/install | Agent CLI `run:ios --configuration Release --device 00008130-00010DEE0289001C --no-bundler --output .expo/standalone-ios-upgraded` succeeded with zero errors and two nonblocking build warnings. Installed **1.0.0 (1)**, bundle `com.vikashloomba.piagent`, on **iPhoneV / iPhone 15 Pro / iOS 27**; `.expo/device-upgrade-release-build.log`. |
| Standalone bundle and signature | `codesign --verify --deep --strict` passed. Embedded Hermes `main.jsbundle` is **10,959,583 bytes** with magic `c61fbc03c103191f`; Expo Updates disabled. Artifact: `.expo/standalone-ios-upgraded/piagent.app`. |
| Cold launch without Metro | Confirmed no service on localhost port 8081, terminated/relaunched through `devicectl`, observed process **11481** running and inspected the phone screenshot showing the Chats screen with existing saved conversations. Evidence: `.expo/device-upgrade-launch.json`, `.expo/device-upgrade-processes.json`, `.expo/device-upgrade-phone.png`. |

This physical-device check establishes installation, embedded-bundle startup and retained chat visibility. It does not claim a new authenticated provider request or a rerun of every bash conformance probe on the release phone. The existing [bash verification record](bash-tool-verification.md) distinguishes the prior native/browser functional probes. No development server remains running, and the release app was left open on the phone.

The installer still reports an upstream expo-modules-core Worklets peer-range warning for the SDK-selected Worklets 0.13.0; Doctor, compilation, tests and the observed launch pass. SDK dependency selections were retained rather than overriding that upstream peer declaration.

## Native OpenAI web search — October 3, 2026

The modern `openai` provider is decorated with the app's native-search wrapper. Pi still owns the Responses client, SSE parsing, normalized messages, authentication, and function-tool execution. Native output and structural events are committed through public Pi durable documents/hooks; Pi's transcript converter and OpenAI's output-to-input helper provide replay. The custom Swift OAuth callback receiver is preserved.

| Native search validation gate | Result |
| --- | --- |
| Full compatibility/application suite | **266 passed**: 37 package and 229 application tests. Includes 16 native-search integration cases and 15 citation/presentation cases in addition to existing Markdown, auth, runtime, and storage regressions. `.expo/native-search-final-tests.log` |
| Request/persistence/replay integration | Actual wrapped Pi OpenAI provider and OpenAI SDK parser with synthetic HTTP SSE and real Harness/SQLite. Passed native output/metadata/encrypted-content preservation, caller hook composition, official replay normalization, local tools, concurrent chats, cancellation, incomplete/failed responses, persistence failure, recovery, forks, reset, compaction, and context edits retaining response IDs. |
| Static gates | Expo Agent CLI typecheck and lint passed; `git diff --check` passed. `.expo/native-search-final-{typecheck,lint}.log` |
| Production native bundles | iOS and Android Hermes production exports passed. Exported to `/tmp/pi-native-web-search-export`; log `.expo/native-search-final-export.log`. These are bundle checks, not Android device-runtime checks. |
| iOS/Hermes/native SQLite | `node scripts/check-native-web-search.mjs` passed on the iPhone 18 Pro / iOS 27 Simulator. Search was mounted before answer text; completed sources/citations and stable row identity were verified; closing/reopening native SQLite retained the presentation; the next request replayed native items and encrypted reasoning exactly once. Each run used an isolated `pi-web-search-validation-*.db` database and synthetic fetch responses. |
| Physical iPhone installation | At the user's request, built and installed Release **1.0.0 (1)** on **iPhoneV / iPhone 15 Pro**, then cold-launched it successfully. The Chats screen displayed existing saved conversations with Metro unavailable on port 8081. Code-signature verification passed; the embedded 8,159,474-byte bundle contains the native-search inclusion and persistence code. The build reported zero errors and two warnings. Evidence: `.expo/native-search-phone-release-install.log`, `.expo/native-search-phone-launch.json`, `.expo/native-search-phone-launch.png`, and `.expo/native-search-phone-process.json`. This checks installation/startup, not a live search request. |
| Presentation inspection | Inspected running search and completed answers in light/dark appearances on the simulator. Expanded the source list through its handler and verified both source links appeared. Opaque encrypted state was absent from the UI projection. Final native report: `.expo/native-search-final-ios.json`. |
| Repeatable fixture cleanup | Passed repeated native runs and appearance changes after cleanup. The fixture preserves React hook order, restores public runtime methods, removes its temporary global, closes its isolated service, and returns to the actual saved chat list. |
| Runtime errors | No errors observed during a bounded two-second runtime-error capture after the final native checks and theme restoration. `.expo/native-search-final-runtime-errors.json`. This does not cover errors outside that observation window. |
| Live OpenAI inference | **Not tested.** Synthetic SSE verifies app/SDK behavior, not real account entitlement, hosted search execution, or OpenAI service availability. No saved credentials were read by the probe and no model HTTP request was sent. |

Repeat the native probe using the commands in the [app README](../README.md#native-openai-web-search). The wrapper depends on signal identity verified for pinned Pi 1.0.0; retain the integration gates on SDK upgrades. Native citation offsets are kept unchanged in storage. Where astral Unicode makes prose-range units ambiguous, the UI keeps clickable sources without guessing an inline span; complete native citation markers can disambiguate the range.

## Swift loopback callback receiver — October 3, 2026

Modern OpenAI browser authentication now receives Pi's `http://127.0.0.1:1455/auth/callback` redirect through a local Swift-only Expo Modules 2.0 module. The plain `@ExpoModule` class exports `@JS` async methods; a Swift actor owns Apple's Network listener, connections, timers, and continuations. The JavaScript coordinator awaits listener readiness before browser presentation and closes/drains Expo's authentication session after callback reception. Pi still owns the public `OAuthAuth` integration, credential mutation, and refresh coordination. See the [module implementation and setup](../modules/pi-oauth-callback/README.md).

The Expo Agent CLI was used for documentation discovery, prebuild, simulator build, runtime evaluation/reload, lint, typecheck, and production export. Its installed package skills contain no Modules guide and the CLI has no documentation command; the supplied [Expo Modules 2.0 introduction](https://expo.dev/blog/an-early-look-at-expo-modules-2-0) and installed Expo macro/autolinking sources supplied that guidance.

All native checks below ran on **iPhone 18 Pro / iOS 27 Simulator**, UDID `B183F5E1-0B91-4DDD-B2FD-CB161448094D`. No physical iPhone installation or verification was performed for this change.

| Callback receiver validation gate | Result |
| --- | --- |
| Compatibility and application regressions | **235 tests passed**: 37 package and 198 application tests. Includes readiness, early callbacks, browser-dismissal races, abort during startup, occupied-port/manual fallback, and Expo browser-lock cleanup. `.expo/callback-final-tests.log` |
| Native Swift and macro build | Swift 6 complete concurrency compilation passed. Expo Agent CLI simulator build succeeded with **zero errors** and one pre-existing Expo dev-launcher build-script dependency warning. The rebuilt app installed and launched on the simulator. `.expo/callback-module-build.log` |
| Real TCP receiver | Passed actual loopback requests through Hermes and the Swift module. `lsof` observed exactly `127.0.0.1:1455`; malformed Host/path/method/state and duplicate/missing parameters did not consume the waiter. Fragmented requests, oversized headers, five-second incomplete-read deadline, static response privacy, one-shot/early delivery, cancellation, stale cleanup, port collision, and rebinding passed. `.expo/callback-native-tcp-report.json` |
| Actual native authentication browser | **Passed automatic return.** A real Expo iOS authentication browser followed one synthetic HTTP 302 to the Swift listener. It closed automatically, required no manual callback entry, retained the actual PKCE verifier and SDK redirect, performed one intercepted token exchange with the issued client ID, and completed real Pi `Models.login`. The synthetic credential stayed in an isolated in-memory store; temporary hooks and the local server were cleaned up. `.expo/callback-native-browser-report.json` |
| Runtime destruction | With an active listener and pending native waiter, an Expo CLI dev-server reload removed the old JavaScript marker, released port 1455, and allowed the new module to start/stop immediately. The simulator app retained process ID `42592`, demonstrating runtime cleanup without process termination. `.expo/callback-reload-{before,marker,after}.json` |
| Reload-command observation | **CLI observer limitation:** `runtime:reload` exited 22 because the debugger target ID remained unchanged. The separate old-marker, same-process, and port/rebind assertions above established the actual lifecycle result; the command itself is not reported as passing. `.expo/callback-reload-cli.{json,log}` |
| Static and production gates | Expo Agent CLI lint and typecheck passed, `git diff --check` passed, and production iOS Hermes export succeeded in `.expo/callback-module-export-ios`. `.expo/callback-final-{lint.log,typecheck.json}` and `.expo/callback-module-export.log` |
| Runtime error capture | No errors in the final two-second observation after the independently confirmed reload. This is a bounded observation. `.expo/callback-final-runtime-errors.json` |
| Live OpenAI authorization | **Not tested.** Synthetic browser redirects and intercepted token responses verify native transport and SDK integration, not real consent, token issuance, account entitlement, or inference. |

Repeat the transport checks with `node scripts/check-native-openai-callback.mjs --port 8081` and the real-browser fixture with `node scripts/check-native-openai-browser.mjs`; accept **Continue** in the simulator's synthetic localhost sign-in prompt. Both scripts enforce simulator identity before using the module. Browser unavailability, occupied ports, and builds without the native module retain the original same-request manual fallback. This receiver adds automatic return for browser authorization; it does not add a modern device-code route absent from Pi's SDK.

## Browser-only modern authentication before the native receiver — October 3, 2026

The `openai` provider now has a native Expo implementation of Pi's public `OAuthAuth` interface alongside its API-key method and the separate legacy `openai-codex` connection. Pi still owns provider catalogs, request authentication, credential mutation, and refresh coordination. The adapter uses Expo AuthRequest/PKCE, Crypto, WebBrowser, Linking, and SecureStore; it does not import Pi's desktop Node OAuth implementation. See the [modern adapter documentation](../src/pi/openai-auth/README.md).

**The modern Pi SDK flow has no device-code route.** Installed Pi AI 1.0.0, published 1.0.1, and upstream revision `83692682f095528f8b71652ddacff7075e36e893` were inspected. Modern authentication uses browser authorization plus a full callback URL through `manual_code`; the device-code route belongs to legacy Codex. `pi-durable` consumes the configured `Models` instance and adds no authorization implementation.

| Modern authentication validation gate | Result |
| --- | --- |
| Combined package/application suite | **227 tests passed**: 37 compatibility/package and 190 application tests; `.expo/modern-auth-final-tests.log` |
| Static gates | Expo Agent CLI lint passed; typecheck reported zero errors; `git diff --check` passed |
| Native simulator build | iPhone 18 Pro / iOS 27 development build succeeded, installed, and loaded the account screen in Hermes |
| Production iOS bundle | Expo Agent CLI export succeeded; `.expo/modern-auth-export-ios` contains the Hermes bundle |
| Native browser callback | **Automatic return does not work for the SDK's HTTP loopback redirect in the tested simulator.** An actual Expo authentication browser followed a synthetic HTTP 302 to `http://127.0.0.1:1455/auth/callback`, displayed an unreachable page, and remained pending until dismissed; it then returned `cancel`. This is a platform callback limitation, not successful automatic login |
| Manual fallback UI | After native dismissal, the real account screen displayed the full callback URL field, external-browser action, disabled empty submit, and cancellation. Cancel cleared the attempt. Only browser destination was substituted; no account token was exchanged |
| Native PKCE and credential persistence | **33 checks passed** with actual Expo Crypto, AuthRequest, and SecureStore in Hermes. Isolated synthetic browser/manual callbacks produced valid PKCE grants; saved issued-client/scopes metadata survived simulator process termination and relaunch. Three concurrent Pi auth calls caused one intercepted refresh; a fresh store recovered the rotated credential without another refresh. No real credential key or legacy account was accessed; the isolated key was removed. Reports: `.expo/native-openai-auth-{prepare,verify,cleanup}.json` |
| Final runtime error capture | No errors reported in the two-second Expo Agent CLI observation after simulator restart; this is a bounded runtime observation, separate from the integration assertions above |
| Adversarial review | Reviewed SDK boundaries, callback/state/PKCE validation, provider isolation, credential rotation/cancellation, prompt lifecycle, and account replacement. Fixed incomplete modern credential validation and removed SQLite reopening as a prerequisite for OAuth; regression tests pass |
| Live OpenAI consent and inference | **Not tested.** Synthetic callback/token fixtures do not establish live service acceptance or account access |
| Physical iPhone | No installation or runtime verification performed for this change; all native checks above used the simulator |

Before the native receiver was added, the tested iOS workflow required manual return. The newer receiver supersedes this limitation; these results remain as the earlier baseline. The initial Expo browser attempt and the fallback retain the same PKCE verifier and state. The existing legacy device-code flow remains available independently.

The repeatable native fixture is `node scripts/check-native-openai-auth.mjs`. Its `--stage prepare`, `--stage verify --namespace <reported-key>`, and `--stage cleanup --namespace <reported-key>` modes permit an explicit simulator restart between preparation and verification. Expo Agent CLI's automatic reload observation timed out in this environment; the verification stage independently checks that the JavaScript runtime changed. A reload-command failure is reported separately from credential/protocol assertions.

## Current durable chat migration — October 2, 2026

The application now uses `@earendil-works/pi-durable` **1.0.0** and `@earendil-works/chord` **1.0.0**, together with Pi AI **1.0.0**. The app no longer depends on Agent Core or starts a fresh in-memory conversation for every prompt. A shared durable `Harness` owns multiple conversations, the local `add_numbers` tool, submitted inputs, task checkpoints, and committed streaming state. The chat UI reads projections of those durable records.

`src/pi/storage/` is the custom Expo SQLite driver. It opens an owned `expo-sqlite` **58.0.8** connection to `pi-chats.db`, configures WAL, and passes an asynchronous database facade to Pi's portable `SqliteStorage.open`. The adapter serializes ordinary operations, transactions, and close; invalidates settled transaction handles; preserves callback errors after successful rollback; and reports rollback failure separately. Schema, migration, document, and record semantics stay in Pi's upstream storage core. Safe-range bigint parameters bind exactly; larger bigint values are rejected instead of rounded.

The app's service hydrates every page of conversations, entries, and submission records before registering its commit listener and enabling work. `send`, `resume`, `cancel`, and direct `waitForSubmission` keep scheduler and UI state aligned. Committed transcript projections are cached between streaming-only publications. Provider errors, including empty assistant responses, remain visible in history, and provider tool-call IDs reused across turns receive distinct UI row IDs.

The runtime requests a harness/storage close when the app backgrounds, then reopens it on foreground activation. Unfinished committed work is recoverable and stays paused while signed out. Foreground recovery may issue a new model request; continuous execution while the operating system suspends the app is not promised. OAuth credentials persist through Expo SecureStore on native platforms and restore after process restart. Pi owns refresh coordination through the app’s serialized credential store; rotated tokens are committed before authentication resolves. Tokens are not persisted in SQLite. Signing out leaves saved chats intact and stops model dispatch before deleting credentials; deletion failure preserves a retryable paused state.

| Durable migration validation gate | Result recorded for this implementation |
| --- | --- |
| Portable storage conformance | **23 upstream cases passed** against the custom driver and real SQLite through a Node native-boundary fixture |
| Additional storage driver checks | **10 passed**: bindings, serialization, handle lifetime, rollback and commit failure, close, initialization cleanup, and reopening a persisted database |
| Durable chat integration | **15 passed** using the real Harness, driver, and SQLite with a scripted provider; includes streaming/tool loop, follow-up context, errors, cancellation, deduplication, restart recovery, concurrent chats, 101-conversation hydration, more than 200 entries, more than 100 submissions, reused tool IDs, stable partial-to-committed row identity, and immutable row/summary reuse |
| Final app typecheck/lint and combined suite | Passed after the secure authentication changes; **159 tests** (37 compatibility/package + 122 app). The complete suite is recorded in `.expo/auth-final-tests.log` |
| Lifecycle controller tests | **17 passed**: one database owner, close-before-logout, background/foreground recovery, auth gating, stable stream/control projections, failure cleanup, backgrounding during auth/send, independent credential restoration, retry, invalidation, and retained sign-out intent after deletion failure |
| Secure authentication regressions | **23 credential-store + 15 Pi/OAuth integration tests passed**, including restart restoration, one serialized refresh, rotated-token write retry, permanent/transient failures, logout, and preserving a completed rotation after caller cancellation |
| Native Keychain persistence and refresh | Passed with actual Expo SecureStore on iOS 27/Hermes across simulator app-process termination and relaunch. An access JWT over 8 KiB and refresh token over 2 KiB restored successfully; three concurrent real Pi auth calls caused one intercepted refresh; a fresh store recovered rotation; deletion was verified from both a fresh store and native storage. Isolated synthetic credentials only. Reports: `.expo/auth-native-{prepare,verify,cleanup}.json` |
| Incremental Markdown tests | **10 passed**: partial list items, headings, opening/closing code fences, inline emphasis/code, links, unchanged-block identity, and incremental/fresh parse equivalence across token boundaries and rewinds |
| Native streaming presentation | Default iOS/Hermes probe passed: 468 chunks / 6,075 Markdown characters; 452 measured frames with changing scroll offsets, zero backward steps, largest forward step about 80 points, final offset at the measured bottom, and the same assistant row ID and React fiber at completion |
| Native reader-control check | Passed on the iOS simulator with an actual native drag and an accessibility tap on scroll-to-latest. During the stationary reading interval, content grew by **1,220.67 points** while scroll-offset drift and range were both **0**. Following resumed after the tap and settled at offset **8,774**, the measured bottom, with stable assistant ID and React fiber. The provider was scripted; no live model requests |
| Current durable iOS/Android production exports | Both passed again after the secure authentication changes via Expo Agent CLI; Hermes bytecode/source maps are in `.expo/auth-export-native`. Native SecureStore and the credential adapter are present; the web credential adapter, Agent Core, and Pi 0.87.1 are absent |
| Web export | Passed with opt-in browser transformation, SQLite worker/WASM, and isolation-header configuration; browser runtime not yet verified |
| Expo Doctor | **20/20 passed** |
| Native SQLite and durable chat smoke | Rebuilt iPhone 18 Pro/iOS 27 development client; boot smoke and actual Expo SQLite integration passed. Real durable Harness with a scripted provider performed five requests, local tool result 42, committed partial, database reopen, signed-out pause, same-submission recovery, and provider-signal cancellation |
| Repeatable native regression command | `pnpm test:native` passed on iOS/Hermes with its own SQLite database; cancellation also survived another reopen without restarting the provider |
| Standalone physical iPhone installation | Rebuilt with Expo SecureStore and the final authentication changes, then installed Release **1.0.0 (1)** on the connected iPhone 15 Pro / iOS 27. Code-signature verification passed. The embedded Hermes bytecode version is **99**, with a **5,893,832-byte** bundle. A terminate-existing cold launch with Metro stopped and port 8081 not responding displayed Chats, existing saved history, and the sign-in action. Evidence: `.expo/phone-auth-standalone.png`, `.expo/phone-auth-standalone-verification.json`. OTA updates are disabled |
| Final development-runtime error check | After process relaunch and the native auth probe, the debugger answered and the two-second observation window recorded **0 runtime errors** in `.expo/auth-native-runtime-errors.json` |
| Native chat UI | Creation, suggestion selection, sign-in navigation, persisted transcript rendering, tool expansion, copying, rename, and archive checked in the simulator; light and dark appearances inspected. The temporary preview database was replaced with the simulator's original chat database afterward |
| Live authenticated ChatGPT request | Requires real user authorization; synthetic tests make no live provider requests |

The Node fixture substitutes only Expo's native database connection with `node:sqlite`; it runs the actual app driver and Pi storage implementation. It establishes SQL/storage and service behavior, not native module installation or OS lifecycle behavior. The native probe separately uses Expo SQLite and Hermes; only its model provider is scripted. Live authenticated ChatGPT requests, physical-device suspend/termination under OS pressure, and Android device execution remain unverified.

The native recovery probe exposed a Hermes property-key bug: `Object.getOwnPropertyDescriptor(proxy, 0)` passes the number into a Proxy trap instead of the string `"0"`. Chord's tracked arrays reject that numeric key, so copying a saved partial during recovery failed strict JSON validation and the scheduler repeatedly retried. The `expo-pi` transform now converts only Chord JSON's indexed descriptor lookup to `String(index)`. Tests reproduce the original failure using Chord's actual tracker, verify strict validation and copy isolation, and check that the rewrite is scoped and idempotent. The complete native probe passed after the fix, including the formerly failing recovery and cancellation paths. No dependency files or global JavaScript built-ins are patched.

### Streaming presentation and repeatable check

The streaming UI now separates the transcript subscription from the header/composer control subscription. The durable service ignores task-only publications, reuses unchanged row and summary objects, and keeps an assistant's row identity through streaming, completion, interruption, and SQLite reopen. Tool identities also include their assistant turn, so a reused provider call ID cannot replace a previous turn's row. The runtime prepares immutable control snapshots before notifying React; selector reads do not mutate a render-time cache.

Markdown parsing retains completed block objects and updates the unfinished suffix. Partial headings, list markers, code fences, emphasis, and links no longer repeatedly switch an existing block into a different layout while their delimiters arrive. The transcript uses measured content height and one retargeted UI-thread scroll animation. Dragging cancels following immediately; returning near the bottom or choosing the scroll-to-latest button re-enables it. Reserved status/footer space avoids a final layout jump when the working indicator clears. Pi's upstream 100 ms partial-write cadence is unchanged.

Run the visual regression with a foreground iOS Hermes development build connected to Metro on port 8081:

```sh
node scripts/check-native-streaming.mjs
```

It opens a unique `pi-streaming-validation-*.db`, seeds earlier history, and streams a Markdown response through the real service for approximately eight seconds. It then verifies that the measured transcript followed growing content, ended at the bottom, and preserved the final assistant's row ID and React fiber. The JSON report includes frame-time percentiles, scroll offsets, render commits, and JavaScript scroll-command counts. The script restores its temporary hooks, returns home, and closes its validation session; it does not use account credentials or make model HTTP requests.

For a reader-control check, run `node scripts/check-native-streaming.mjs --manual` in one terminal. It defaults to 60 seconds; add `--duration-seconds 120` for slower device automation. During the stream, drag upward on the actual device or simulator and let scrolling settle. From another terminal, mark the stationary reading interval:

```sh
npx @expo/agent-cli runtime:eval "globalThis.__PI_STREAMING_PROBE__.markPhase('reading-history')" --platform ios --port 8081 --json
```

Leave the transcript untouched for several seconds while text continues arriving. Before tapping the scroll-to-latest button, end that measurement interval:

```sh
npx @expo/agent-cli runtime:eval "globalThis.__PI_STREAMING_PROBE__.markPhase('jump-to-latest')" --platform ios --port 8081 --json
```

Then tap **Scroll to latest message** and observe following resume. The manual report requires content to grow during `reading-history` while the measured offset varies by no more than two points. It uses actual native gestures; no JavaScript event-handler calls stand in for a drag. Inspect the growing Markdown and completion transition as part of this run. Native streaming measurements are a separate gate from the 122 Node tests above. JavaScript `requestAnimationFrame` timing measures JS responsiveness; it does not establish UI-thread FPS, and UI-thread Reanimated commands do not appear in the JavaScript scroll-command counters.

The recorded 120-second manual run passed every check in `.expo/streaming-manual.json`. A native drag in the simulator moved to earlier history. After it settled, the measured offset stayed exactly at **0** while content height increased from **4,164.33** to **5,385** points. An actual accessibility tap on scroll-to-latest resumed following through the remaining output. The final content height was **9,400.33** points with a **626.33**-point viewport and offset **8,774**, matching the bottom within measurement precision. The final message kept both its streaming row ID and React fiber. This validates simulator gesture behavior with the real UI, Hermes, durable service, and Expo SQLite, using a scripted provider.

References: [Expo SDK 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/), [Pi durable storage contract](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/storage/sqlite/database.ts), [Pi durable Harness](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/harness/harness.ts).

## Earlier Agent-only migration — October 2, 2026 (superseded)

This section records the earlier same-day Agent Core migration and its validation results. The runner described here has since been replaced by the durable chat implementation above. These earlier native checks do not validate the new SQLite adapter or chat lifecycle.

The live npm `latest` tags for both `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are **1.0.0**. The app dependencies and `expo-pi` development dependencies are exact-pinned to that version. The lockfile resolves a single Pi AI version; its OpenAI SDK dependency is now **7.19.0**. Existing Expo updates in the checkout were preserved: Expo **58.0.2**, React Native **0.88.0-rc.3**, and `expo-crypto` **58.0.4**.

Pi 1.0 removed `AgentHarness`, `MemorySessionRepo`, and the lane API from Agent Core. Its separate `pi-durable` package has a new experimental API, not the old exports under another path. Since the demo starts a fresh in-memory conversation per run, `src/pi/harness.ts` now uses the stable `Agent` API. It retains the local tool, streamed progress, fresh transcript and cache session ID, and routes requests through `models.streamSimple` for Pi-owned credential resolution and refresh. Explicit SSE, zero retries, and a 60-second request timeout are preserved.

Cancellation is passed through auth preflight and then to `agent.abort()`, reaching the provider's signal. `Agent.prompt()` can resolve after an error, so the runner inspects terminal assistant outcomes and `agent.state.errorMessage` before reporting success. Subscriptions and abort listeners are removed after settlement. The native OAuth adapter and existing `openai-codex` / `gpt-6-sol` selection remain compatible.

Upstream references: [Agent 1.0 changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/CHANGELOG.md), [Agent source](https://github.com/earendil-works/pi/blob/v1.0.0/packages/agent/src/agent.ts), [Pi AI changelog](https://github.com/earendil-works/pi/blob/v1.0.0/packages/ai/CHANGELOG.md).

| Validation gate | October 2 result |
| --- | --- |
| App typecheck and lint | Passed |
| `pnpm test:compat` | **55 passed**: 31 native compatibility/package checks and 24 app protocol/integration tests |
| Agent regression coverage | Real Agent/Models, scripted provider: incremental text, tool result 42 sent to the next turn, invalid arguments, fresh transcripts/session IDs, request options, provider errors, active cancellation, cancellation during auth, missing auth/model |
| OAuth regression coverage | Real adapter, Models, credential store, Codex SSE provider and Expo request/PKCE builders; synthetic HTTP responses cover login, one serialized refresh for eight concurrent callers, refresh failure/retry, bearer/account headers, logout, cancelled login and callback PKCE |
| `npx @expo/agent-cli doctor` | **20/20 passed** |
| iOS and Android production exports | Passed, including Hermes bytecode and source maps |
| Bundled dependency identity | Both platform source maps contain Pi AI and Agent Core **1.0.0**, with no 0.87.1 paths |
| Frozen lockfile install | Passed; no dependency resolution changes |
| Native iOS build and smoke | Passed on iPhone 18 Pro / iOS 27.0: development build compiled and installed, Hermes answered, zero runtime errors during the smoke window, and the sign-in screen rendered correctly |
| Loaded simulator dependency identity | Metro's running module table confirmed Pi AI and Agent Core **1.0.0** after the clean restart |
| Tool loop and cancellation on Hermes | The actual app runner with real Agent/Models and a scripted provider completed two requests, executed `add_numbers(19, 23)` locally, returned `{sum: 42, platform: 'ios', runtime: 'on-device'}` to the next turn, and cancelled a second run through the provider's abort signal; no HTTP requests |

The tests use synthetic credentials and responses. Authenticated ChatGPT streaming on a device, the registered mobile client's server-side callback acceptance, and Android runtime behavior remain separate live checks. The native Metro wrapper required no implementation changes for Pi 1.0.0; the installed-module test is a rewrite scan, while the production exports above are the actual bundle gates.

After a dependency upgrade, stop any running Metro server and restart with `--clear`; export with `--clear` as well. During this upgrade, an initial export and simulator launch reused cached 0.87.1 paths despite updated pnpm symlinks. Clearing the cache, inspecting source-map package paths, and checking the running Metro module table established that both production bundles and the simulator actually contain 1.0.0. The smoke and native tool-loop checks above passed after that clean restart.

Package installation still reports Expo's existing `expo-modules-core` peer range excluding the workspace's SDK-selected `react-native-worklets@0.13.0`. Expo Doctor accepts the installed set. This warning is unrelated to the Pi update.

## Historical verification — September 23–24, 2026

The sections below record the original Pi 0.87.1 checks and superseded implementation. Current versions and behavior are described above.

## Exact versions and source

| Component | Version |
| --- | --- |
| Expo | 58.0.0-preview.6 |
| Expo CLI (`npx expo --version`) | 58.0.6 |
| React Native | 0.88.0-rc.1 |
| React | 19.3.0 |
| Pi AI / Agent Core | 0.87.1, exact-pinned |
| OpenAI SDK in Pi's dependency graph | 6.40.0 |
| expo-crypto | 58.0.2 |
| expo-auth-session / expo-web-browser | 58.0.4 / 58.0.2 |
| expo-dev-client | 58.0.6 |
| Node / pnpm | 24.5.0 / 10.33.0 |
| Simulator | iPhone 18 Pro, iOS 27.0, Hermes |
| Xcode | 27.0 (27A266a) |

The app initially had no Pi dependencies. npm's current release for both Pi packages was 0.87.1. Upstream HEAD was `b45597504eeaba1f11a9920a1d1048c361ed4b8e`, matching the previous redirects' reviewed commit. Installed JavaScript and its source maps were inspected, alongside a fresh upstream checkout.

Three of the four original shim targets matched upstream source exactly. Upstream `env-api-keys.ts` had an additional `typesafe` mapping absent from the published npm 0.87.1 artifact. The local shim was corrected to follow the **installed artifact**, and a test covers that distinction.

The selected provider is now `openai-codex`, with `gpt-6-sol` from the installed Pi catalog. Its transport and model definitions remain unchanged. The app replaces only the provider's desktop OAuth implementation through Pi's public `Provider.auth.oauth` interface.

## Reproduced failure and narrow replacements

> **Superseded (2026-09-24):** the module replacements and exact-version guard below were replaced by the [`@automatalabs/expo-pi`](../packages/expo-pi/README.md) Metro transform, which keeps Pi's own modules and rewrites only their variable `import()` calls. The record below describes the checks as originally run.

A reachable app screen imported Pi's public root APIs and a selected provider with no Metro redirects. The native iOS export failed in `pi-ai/dist/env-api-keys.js`:

```text
Invalid call at line 13: import(__rewriteRelativeImportExtension(specifier))
```

The relevant paths are:

```text
app → pi-agent-core → pi-ai → auth/context
app → pi-ai/providers/openai-codex → auth/helpers → auth/oauth/load
app → pi-ai/providers/openai-codex → openai-codex-responses.lazy
    → openai-codex-responses → utils/provider-env
```

Metro must statically analyze dependency expressions even if desktop-only code would never execute on Hermes. Native redirects operate on the normally resolved file and verified owning package. They delegate to an existing resolver, and leave web/server resolution intact.

| Target | Reason | Native behavior |
| --- | --- | --- |
| `auth/context` | Variable imports of Node filesystem / OS | Keep auth contract; desktop credential-file discovery returns false |
| `env-api-keys` | Variable imports of Node filesystem / OS / path | Keep explicit environment lookup; omit Google ADC file discovery |
| `utils/provider-env` | Bun `/proc/self/environ` fallback requires `node:fs` | Keep scoped and existing ambient environment lookup |
| `auth/oauth/load` | Variable imports of desktop OAuth implementations | Explicit unsupported error on invocation unless native loaders are registered |

The OAuth loader target is reached by the Codex factory. Its desktop implementations stay out of the native graph; the app injects its mobile implementation after constructing the real provider. The app also injects a non-discovering auth context and its Expo SecureStore credential adapter rather than reading desktop credentials.

The resolver rejects unreviewed Pi AI versions. Pi dependencies are exact-pinned. On upgrades, re-inspect both the installed package and upstream source, compare contracts, then rerun bundles and device checks before changing the guard. No node_modules files were patched.

## Runtime adaptation

An actual iOS/Hermes probe found `fetch`, `ReadableStream`, `TextEncoder`, `TextDecoder`, `AbortController`, `structuredClone`, and `BigInt` available, but `crypto` / `crypto.getRandomValues` missing. SDK 58's inspected `expo/src/winter/runtime.native.ts` already installs Expo's streaming fetch by default.

The bridge is now part of the [`@automatalabs/expo-pi`](../packages/expo-pi/README.md) package: Metro's transform adds an import of it to each Pi module that calls `crypto.getRandomValues`, so it is installed before Pi uses it, without a custom entry file. (At the time of these checks, `index.js` imported it before `expo-router/entry`.) It conditionally exposes **only** `expo-crypto.getRandomValues` through `globalThis.crypto`. It preserves an existing implementation. It does not claim to provide `crypto.subtle` or all Web Crypto. Expo Go already includes this native module.

Afterward, the running Hermes app passed secure random generation, UTF-8 encode/decode, structured cloning of BigInt, AbortController state, and ReadableStream construction probes. No fetch, stream, encoding, Buffer, filesystem, or Node builtin polyfills were added.

## Codex dependency graph and OAuth

The final iOS and Android source maps contain only the `openai-codex` factory/catalog plus Pi's root-exported `faux` utility. The app never selects `faux`. Neither Pi's desktop `auth/oauth/openai-codex` nor the Node harness environment appears in the graph.

Pi's actual `openai-codex-responses` adapter streams directly to ChatGPT. Its optional Node zlib/user-agent/proxy paths are runtime-guarded. The WebSocket path assumes the Node/Bun constructor signature for authentication headers; React Native uses a different signature. The harness explicitly selects `transport: 'sse'` so Pi uses Expo SDK 58's default native streaming fetch. No replacement model transport or backend agent loop was added.

### Expo OAuth adapter

The adapter is packaged in `src/pi/codex-auth/`; its [module README](../src/pi/codex-auth/README.md) documents integration and browser lifecycle ownership.

Pi's public `Provider.auth.oauth` interface is the integration point. The app replaces only `login`, `refresh`, and `toAuth`; Pi continues to own credentials, serialized refresh and request authentication. Pi's desktop redirect is not a requirement of AgentHarness or Models.

The previous `SFSafariViewController` plus native loopback receiver was removed. There is no `CodexCallback` module or listener in the current source. The iOS app uses Expo SDK 58 `ASWebAuthenticationSession` through `openAuthSessionAsync` or `AuthRequest.promptAsync`.

With the existing Codex public client, the default is OpenAI's device-code flow, matching Pi 0.87.1's `auth/oauth/openai-codex` protocol. The app requests a code, emits Pi's `device_code` notification, and polls with the server-provided interval. Pending and slowdown responses are handled separately; slowdown increases the interval by five seconds. The fifteen-minute deadline also cancels an in-flight request. Cancellation stops fetches/timers and closes an open authentication browser. Closing the device-code browser alone leaves authorization pending so the user can approve it on a physical phone. No Bluetooth pairing or incoming device callback is needed for this route.

After approval, Expo's `AccessTokenRequest` builds the exchange using OpenAI's returned code/verifier and its server-side device callback. `RefreshTokenRequest` builds refresh requests. Their request builders are sent through cancellable fetch because their built-in `performAsync` does not accept an AbortSignal. Response errors omit remote bodies and credentials. Tokens are converted to Pi's OAuthCredential, including expiry and ChatGPT account ID.

For a separately registered mobile OAuth client, `EXPO_PUBLIC_CODEX_OAUTH_CLIENT_ID` enables `makeRedirectUri({ scheme: 'piagent', path: 'auth/callback' })` and `AuthRequest.promptAsync`. Expo creates PKCE/state and handles the system callback. Additional validation compares custom-scheme URL components (their origin is `null`) and requires one matching state and one code. This branch requires an OpenAI registration allowing the app callback and Codex access; no such registration has been supplied, so end-to-end validation is pending.

A live browser comparison of otherwise identical authorization requests showed the existing client returning an authentication error for `piagent://auth/callback` and reaching the login page for the desktop localhost URI. This establishes that changing only the redirect did not work in that check; it is not a complete enumeration of the server's allowlist. An unauthenticated HTTPS request to the device-code endpoint returned 200 with the expected device code fields; credentials were not entered or imported.

References: [SDK 58 AuthSession](https://docs.expo.dev/versions/v58.0.0/sdk/auth-session/), [SDK 58 WebBrowser](https://docs.expo.dev/versions/v58.0.0/sdk/webbrowser/), [OpenAI device-code authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices).

## Harness integration

The screen uses `AgentHarness.create`, `MemorySessionRepo`, `createModels`, `InMemoryCredentialStore`, `openaiCodexProvider`, and Pi's exported TypeBox schema constructor. `add_numbers` validates numeric arguments through Pi, returns `{sum, platform, runtime: 'on-device'}`, and has no filesystem or shell access. Text deltas and tool/run events update React state as they arrive.

Pi 0.87.1's context cancellation stops observation, not necessarily the underlying operation. The app's AbortController therefore explicitly calls `lane.requestAbort(operationId, BACKGROUND_CONTEXT)` and awaits `lane.drive` settlement. This routes cancellation through Pi's durable operation lifecycle to its provider AbortSignal. The abort listener, event listeners, harness, and repository are cleaned up at the end of each run. Credentials survive runs until sign-out or app termination.

## Observed verification

| Check | Result |
| --- | --- |
| Unmodified reachable Pi graph / iOS export | Failed with variable-import error as expected |
| Redirected Pi graph / iOS Hermes export | Passed |
| Final Codex graph / iOS production-style export | Passed, 4.9 MB Hermes bytecode |
| Final Codex graph / Android production-style export | Passed, 5.0 MB Hermes bytecode |
| Initial harness iOS launch | Passed in Expo Go on iOS 27.0 / Hermes, before OAuth addition |
| Current iOS development build | Rebuilt, signed for simulator and installed successfully after removing the callback module; 0 errors and 1 upstream script warning |
| Current development-client runtime | Passed on iOS 27 / Hermes as `com.vikashloomba.piagent`; new device-code screen rendered |
| Live device-code request | Passed from the rebuilt iOS app against OpenAI; one-time code displayed |
| Expo authentication browser | Native ASWebAuthenticationSession permission prompt appeared for auth.openai.com |
| Live login cancellation / retry | Cancel dismissed the native authentication prompt, cleared the code, returned to signed-out state; subsequent login received a fresh code |
| Registered mobile callback flow | Implemented with AuthRequest.promptAsync; requires an OpenAI-issued mobile client to verify end to end |
| Native runtime API probes | Passed after secure-random bridge |
| `@automatalabs/expo-pi` package (2026-09-24) | Replaced the four copied modules and version guard with a Metro transform of Pi's own code. App and npm-installed tarball consumers (only `pi-agent-core` and `expo-pi` listed; Pi 0.87.1 and 0.84.4) exported for iOS and Android; a consumer without `withPi` failed with the variable-import error; `expo-crypto` autolinked transitively; iOS dev client passed smoke, and on-device probes of Pi's `uuidv7`, `fileExists` and desktop OAuth loader behaved as documented |
| Current runtime error check | No errors observed in the post-retry two-second debugger capture window |
| TypeScript | Passed |
| ESLint | Passed |
| Expo Doctor | 20/20 passed |
| Redirect/shim tests, including installed-mapping regression | 40/40 passed (31 compatibility + 9 OAuth/device protocol checks) |
| Authenticated Codex streaming / on-device tool / final response | Pending real ChatGPT sign-in |
| Cancellation during live Codex streaming | Pending real ChatGPT sign-in |
| Android device/Hermes runtime | Not run; user requested iOS focus |
| Standalone release app / physical iPhone | Not run; development simulator build only |

The starter template had a web ref type mismatch and a hydration effect rejected by the installed React lint rules. The web tab uses the current Pressable ref type, and hydration uses `useSyncExternalStore`. These are small template fixes to satisfy the required checks, with no suppressed lint/type rules.

## Remaining production work

This is a minimal development integration, with a fresh in-memory session per prompt. Persistent conversations, secure persisted user credentials, app-owned authenticated gateways, background/suspend lifecycle handling, physical-device/release validation, and broader tool/provider coverage are separate work. Desktop OAuth and Node execution adapters remain excluded. Authentication browser presentation is currently iOS-only. Physical-device and suspend/resume behavior remain to be verified; no background execution is assumed. A registered mobile client is required to validate the direct Expo callback branch.

The SDK/RN versions are prereleases. Package installation reports peer-range warnings for Reanimated/Worklets; Expo Doctor nevertheless passes. Metro also reports an upstream virtualized-lists private-export fallback warning. Neither blocked the observed native bundles or iOS launch, but they remain upstream prerelease caveats.

The current rebuild reported **Build Succeeded**, zero errors and one upstream Expo Dev Launcher build-script dependency warning. No compiler settings or dependency sources were changed. The detached agent-cli readiness wait expired while compilation was still running; the build continued, installed successfully, and Metro subsequently became ready. No credential exchange or live model run is claimed yet; the rebuilt simulator app displayed a real code for user authorization.
