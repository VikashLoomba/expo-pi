# Local workspace tools implementation and verification record

Verified on 2026-10-04 against the existing Expo 58.0.2, expo-sqlite 58.0.8, React Native 0.88.0-rc.3 and Pi durable 1.0.0 checkout. New runtime dependencies are pinned to just-bash 3.6.0, fflate 0.8.2 and buffer 6.0.3. The complete requested scope is retained in [the implementation goal](bash-tool-implementation-goal.md); architecture, ownership and maintenance procedures are in [the implementation guide](bash-tool.md).

**Subsequent SDK patch update:** Expo 58.0.3 and expo-sqlite 58.0.9 are now installed, Doctor passes 20/20, and all 337 regression tests pass. The rebuilt standalone Release app was installed and cold-launched on the physical iPhone 15 Pro without Metro. See the [October 4 device-upgrade record](ios-compatibility.md#expo-patch-update-and-standalone-iphone-installation--october-4-2026). The implementation-time results below retain their original tested versions and distinguish them from the later upgrade/startup check.

This was implemented in a checkout that already contained substantial modified and untracked app code. Existing work was preserved. Generated CNG native files were produced through Expo tooling, not manually edited. The final implementation was tested with compatibility adapter cache revision `pi-bash-v3`.

## Automated and platform gates

| Gate | Observed result | Evidence |
| --- | --- | --- |
| `pnpm test:compat` | 37/37 compatibility-package tests and 300/300 app tests passed | `.expo/bash-regressions-final.log` |
| Expo Agent CLI lint | Passed | `.expo/bash-final-lint.log` |
| Expo Agent CLI typecheck | Passed, zero diagnostics | `.expo/bash-final-typecheck.json` |
| Expo Agent CLI export, iOS and Android | Both Metro graphs and Hermes exports passed | `.expo/bash-export-final.log`, `.expo/bash-export-final/` |
| Expo Agent CLI export, web | Client, workers and Router server export passed | Same export log/directory |
| Actual iOS Hermes runtime | Bash was offered and executed through real Pi; persistence passed after process termination and relaunch | `.expo/bash-native-seed.json`, `.expo/bash-native-verify-final.json` |
| Actual Chromium runtime | Bash/Pi/Expo SQLite persistence passed after reload | `.expo/bash-browser-verify-final.json` |
| Browser workspace factory concurrency | Two leases committed and retained all 20 appends; namespace isolation, partial lease close, lock release and reopen passed | `.expo/bash-browser-pooled.json` |
| Native resource limits | Loop budget, timeout, no late write and bounded gzip expansion passed | `.expo/bash-native-limits.json` |
| Native error observation after final probe | Zero errors in a two-second readable-runtime window | `.expo/bash-runtime-errors-final.json` |
| Expo Doctor | 19/20 checks passed; SDK patch-version drift remains | `.expo/bash-doctor.json` |

The `.expo` files are local ignored validation artifacts, not a committed logging API. Tests and the reusable native probe are in the repository so the checks can be repeated. The native development build was compiled, installed and launched through Expo Agent CLI. Runtime verification used an iPhone 18 Pro simulator running iOS 27. Android runtime/device behavior was not exercised; its completed gate is the actual platform export.

The Doctor failure reports 12 newer Expo patch versions, including Expo 58.0.3 and expo-sqlite 58.0.9. This implementation was intentionally verified against the user's installed versions. These patch updates were not bundled into an unrelated dependency upgrade, and the Doctor gate is not reported as passing.

## What the integration checks actually ran

The native and browser probes use the real `DurableChatService`, installed Pi execution, the exact adapted browser shell, Expo SQLite and platform crypto. Model transport is explicitly scripted: no real-provider HTTP request or authenticated model inference is claimed. No user credential is read, logged or embedded. The app was signed out during this verification.

`scripts/check-native-bash.mjs` restricts its namespace to `pi-bash-*` and opens separate validation chat/file databases. Its serializable helper also runs in the browser Metro runtime. It verifies that the model context offers `bash`, invokes the tool, waits for Pi completion, and checks the recorded tool output. The script is not a substitute for a separate authenticated provider smoke test.

The persisted payload includes Unicode text, bytes `00 FF 41`, an absolute symlink, a relative directory symlink traversed through `link/..`, a hard link, mode `0640`, and a gzip file. After cold restart/reload, the final probe verifies all of these, modifies the hard-link alias and observes the original file, restores its bytes, verifies `/bin/cat` and `/proc/self/status`, exercises dangling-link copy/move/removal, runs `jq`, and confirms that `/tmp` did not survive. Both platforms returned exit 0 and `VERIFIED`. Both computed SHA-256 `a90a10503fbfc95789ff38a1bb5039cb71869ab9c0eb1cb51c4a9099f2933c6b` for the binary payload.

The Pi probe injects the same Expo connection/queued-driver boundary as the production native factory so it can select isolated database names. Browser connection-sharing was separately exercised against the actual `native.web.ts` factory. The latter is necessary evidence: two independently opened Expo browser connections acknowledged 20 appends but retained only 10 bytes before the shared-owner fix. With the production shared queue, both leases acknowledged and retained all 20 bytes. The final page reload cleared test-only module loading and rendered the ordinary Chats screen.

The exploratory browser factory probe loaded a Metro modules-only chunk into the running test page. Its duplicate module registrations triggered three `ChatProvider is missing` refresh errors in that test page. Reloading and a fresh-tab verification restored the normal UI and passed persistence without adding errors. The browser tool retained those same three historical records even after its clear command, so this record does not claim an empty browser error buffer. No such chunk injection is part of the production tool.

The Hermes resource probe observed a bounded-loop failure with exit 126 in 142 ms, a requested 25 ms deadline returning exit 124 in 40 ms, no write after that timeout, and rejection of gzip expansion beyond 4 MiB. The expansion-limit case occupied the simulator's JS thread for approximately 661 ms. These are observations from one simulator run, not physical-device performance guarantees or hard-preemption guarantees.

## Independent adversarial reviews

Three independent agents implemented and cross-reviewed different parts of the change. The filesystem reviewer inspected mount routing and browser connection ownership; the Pi integration reviewer inspected filesystem behavior and lifecycle wiring; the interpreter reviewer inspected runtime cancellation, temporary storage and the actual published browser artifact. The primary agent also reviewed their changes, ran adversarial integration probes and fixed findings. Review was based on changed code plus the relevant unchanged Pi and Expo driver paths, not solely on this checklist.

| Requested engineering criterion | Concrete review outcome |
| --- | --- |
| Idiomatic implementation | Direct Pi `defineTool`/`defineExtension`, an injected `IFileSystem`, the existing owned Expo SQLite driver and platform-specific factory files; no native process shim or global Node environment |
| Reasonable abstractions | Explicit tool, invocation, filesystem and physical-connection ownership; short operation transactions; one BLOB per file; no speculative `ExecutionEnv`, snapshot service or file-sharing UI |
| Organization | Filesystem schema, store, namespace, path, encoding, content and lifecycle modules are separate; engine compatibility, compression, limits, mounted routing, output and Pi documents have cohesive owners |
| Readability and maintenance | Named invariants and lifecycle comments, bounded helpers, exact artifact hash/replacement guards, maintenance documentation and focused behavioral suites; related mount-routing and connection-ownership tangles were resolved without unrelated app rewrites |

Substantive findings were fixed and covered with focused tests or actual platform checks:

- **Physical path routing:** upstream mount routing collapses `link/..` lexically. A bounded resolver now follows virtual symlinks before mount selection and preserves final entries for unlink/rename/exclusive creation. Absolute targets stay in the virtual namespace.
- **Dangling-link commands:** upstream `cp`, `mv`, `rm` and `ln` prechecks could reject links before the filesystem received them. The fingerprinted adapter corrects the relevant checks while preserving no-clobber behavior and conservative identity checks. Directory-link removal leaves target contents intact.
- **System initialization and resource accounting:** the mount decorator now forwards the constructor's synchronous system-file operations. Temporary bytes, entries, paths and copies are bounded, and the system tree is recreated per invocation.
- **Timeout and shutdown ownership:** elapsed wall time supplements timer callbacks; deadlines end before output formatting; timed-out calls cannot spill more files. Aborted calls stop admitting work and drain admitted operations before closure. Cancellation preserves the caller's reason, including `null`.
- **SQL/cache atomicity and namespace bounds:** failed transactions do not publish cache mutations; schema initialization can retry after failure; future schema versions are rejected. Database-wide entry limits supplement byte and per-workspace quotas. Stale handles cannot mutate a replacement workspace.
- **Encoding and native BLOB edges:** empty files use `zeroblob(0)`; malformed UTF-16 paths are rejected before the SQLite bridge changes their spelling; binary reads and hard-link bytes remain exact.
- **Browser concurrency:** the demonstrated lost update from independent browser connections was removed with one transaction queue per named database, reference-counted leases, and a connection-lifetime Web Lock. Final release completes before reopen.
- **Cross-mount failure semantics:** source deletion occurs only after copying succeeds; destination type/emptiness and final-link rules are checked. Failure can leave a partial destination and is documented rather than hidden by unsafe cleanup.
- **Compression integrity and transient allocation:** the small fflate bridge checks gzip CRC32, original size and optional header CRC, limits members/headers, and bounds both output and incremental expansion. Integrity tests cover behavior not provided by fflate itself.
- **Pi document lifetime:** workspace identity is committed durably and returned as a plain value rather than a settled transaction proxy. Existing chat restrictions are updated only for the bash capability; forks receive a fresh namespace with an explicit inherited-transcript warning.

The behavioral suites also cover exclusive creation races, independent SQLite connections, process reopen, hard-link quota/reclamation, directory collisions, unsafe tool recovery, service close, failed initialization, output truncation/spills, existing-chat availability, and fresh fork isolation.

## Deliberate support boundaries

- The browser supports one active app tab. Its Web Lock prevents duplicate workspace-database ownership, but Expo's origin-wide OPFS pool acquires handles before workspace initialization; this does not establish complete multi-tab Pi support. Secure context, Web Locks, OPFS, workers, WASM, and cross-origin isolation headers are required. Expo 58.0.8 has six OPFS backing-file slots, so validation database names must be reused or explicitly cleaned up.
- `/workspace` persists; shell variables, functions, working directory changes and the bounded system tree reset for each invocation. Forks start empty; archive preserves data. There is no new reset/delete UI or historical filesystem snapshot claim.
- Commands are the reviewed interpreter capabilities. JS, Python, network access, native executables and omitted browser commands remain unavailable. The browser artifact has no Node defense-in-depth hooks. Shell strings are not an arbitrary binary terminal; use file bytes/base64 for that purpose.
- Cancellation is cooperative. Synchronous codecs can briefly block the JS thread, an already admitted commit may finish, and earlier writes survive later command failure. Pi marks bash replay unsafe; file commits and transcript commits are separate, so exactly-once execution is not claimed.
- Output is buffered and bounded. Completed large output can spill to virtual files; timeout may lose already-buffered upstream output and does not create spill files. No native URL/export feature is implied.
- One BLOB per file is intentionally simple. Repeated small appends to a large file can be quadratic, and interpreter whole-file allocations remain relevant even if storage were chunked. Quotas bound this workload; the implementation does not claim OS-level CPU/memory isolation or immunity to every device storage failure.

These limits are reflected in the model-facing tool description and architecture documentation where relevant. They are explicit behavior of the completed implementation, not hidden stubbed requirements.

## Shared read, write and edit tools — October 5, 2026

This follow-up uses Expo 58.0.3, expo-sqlite 58.0.9, React Native 0.88.0-rc.3, Pi durable 1.0.0 and just-bash 3.6.0. The only new direct dependency is pinned `diff@8.0.4`, the same version already used by Pi and just-bash. It provides a bounded public diff preflight without copying Pi's matching or diff implementation.

The shared filesystem, mounts, native/web drivers and database ownership moved from `src/pi/bash` to `src/pi/workspace`; seventeen moved files are byte-identical to the pre-session snapshot. Database names, schema and workspace UUIDs remain compatible. Bash keeps its shell-specific deadline and output behavior. A complete typed `ExecutionEnv` adapts the shared mounted filesystem to Pi's public `createReadTool`, `createWriteTool` and `createEditTool` factories. One workspace queue encloses each entire tool call, including edit admission, matching, replacement and result finalization.

Capability migration preserves the persisted `local-bash` extension and `app.bash.workspace` document identity. Document version 2 adds a capability revision, so new tools are adopted once while later deliberate exclusions survive reopening. Live and committed transcript projections carry bounded edit details to the extracted `ToolCard`, whose expanded view shows the path, summary, diff and optional persistent patch path.

Adversarial review followed each of the six implementation phases, with a further architecture review and a fresh independent review of the complete change. Fixed findings included trailing-slash path semantics, fractional read arguments being rounded by Pi's schema conversion, exact post-write cancellation reasons, mixed legacy edit argument presentation, inserted-versus-restored BOM handling in diff admission, patch-spill failure and cancellation semantics, quadratic repeated-prefix searches on Hermes, app-owned synchronous preflight scans, and Unicode normalization expansion/reordering costs. The SDK continues to own actual matching, ambiguity detection, overlap validation, replacement and final diff formatting.

The reusable `scripts/check-native-workspace-tools.mjs` accepts isolated `pi-workspace-tools-*` validation namespaces and seed, verify, performance and UI stages. Its runtime evaluation launches a probe once and polls a unique result slot; an inspector timeout never retries filesystem work. The helper uses the same lazy platform database factory as production. The model transport is explicitly scripted, with real Pi scheduling, SQLite and just-bash execution; these checks do not establish authenticated provider inference.

Native seed and verify ran on a dedicated iPhone 18 Pro simulator with iOS 27 and actual Hermes/Expo SQLite, with process termination and relaunch between stages. They checked all four offered tools, shared Unicode/BOM/CRLF bytes, binary preservation, hard links, fresh temporary storage, strict UTF-8 boundaries and persisted edit details. The UI probe mounted the actual persisted transcript, expanded its real edit card through `onPress`, and compared the displayed diff to the committed projection. Its isolated service was then cleaned up and the ordinary app runtime restored.

Browser seed and verify ran in a dedicated Chromium profile, with a complete browser-process close and reopen. They used the production pooled SQLite factory and verified multiple leases, continued use after one lease closes, final lock release and reopen. A separate 390-by-844 viewport check rendered the real `ToolCard` with captured durable results and verified the expanded DOM state and diff. This is controlled-data component verification, not a live-provider browser conversation.

### Final Hermes edit-work measurements

The final reusable performance matrix passed all **28 cases**, including byte equality after rejection and exact complete-patch readback. The policy was tightened using measured failures: an earlier dense 8 MiB combining-mark file stalled for 5,493 ms even though every individual run fit the initial limit. The final policy bounds both individual runs and aggregate squared run lengths, weighted by edit count. Matching admission also charges the larger of UTF-8 bytes and decomposed UTF-16 units, preventing large multibyte batches from receiving disproportionately high limits.

| Final case | Outcome | Total elapsed | Longest observed timer gap |
| --- | --- | ---: | ---: |
| 8 MiB ASCII, one targeted edit | Applied | 8,447 ms | 667 ms |
| 8 MiB ASCII with one non-ASCII character | Applied | 9,027 ms | 746 ms |
| 8 MiB CJK, one edit | Applied | 4,758 ms | 454 ms |
| 8 MiB CJK, four edits | Applied | 5,213 ms | 576 ms |
| 8 MiB CJK, ten edits | Rejected before matching | 477 ms | 422 ms |
| Aggregate combining work exactly at its limit | Applied | 1,073 ms | 141 ms |
| Aggregate combining work above its limit | Rejected before whole-string normalization | 421 ms | 62 ms |
| 8 MiB dense legal combining runs | Rejected before whole-string normalization | 1,355 ms | 435 ms |
| Near-limit diff materialization | Applied; complete 4,186,476-byte patch persisted | 2,160 ms | 179 ms |

Other cases cover 32 edits, repeated-prefix searches, short ambiguous patterns, huge minified lines, compatibility expansion below and above its limit, expansion weighted across a batch, near-1 MiB old-text arguments, 64/65-unit combining runs, compatibility marks, and the 131,072-line boundary. The largest observed timer gap across the matrix was 760 ms in a rejected diff-budget case.

These are observations from an iOS simulator with the final policy, not exhaustive worst-case bounds or physical-device performance guarantees. The accepted large-file cases still take several seconds, and synchronous SDK intervals can visibly delay the UI. Cancellation is cooperative; it cannot interrupt a synchronous SDK call or undo a file commit already in progress.

Both final reviewers inspected the actual implementation and relevant unchanged SDK/driver seams. Beyond the checked-in tests, the fresh reviewer ran ten instrumented Unicode admission probes; the architecture reviewer checked 48 mixed Unicode fixtures with 96 exact-boundary decisions against a whole-NFKD reference calculation. Rejected inputs reached only scalar normalization calls before failing, and original bytes remained unchanged. These source and oracle checks supplement the actual runtime measurements.

### Final integration gates

All evidence paths below are relative to `.expo/file-tools-validation/` and are local ignored artifacts. The source tests and reusable runtime probes are retained in the repository.

| Gate | Final result | Evidence |
| --- | --- | --- |
| `pnpm test:compat` | 37 compatibility tests and 379 application tests passed; 416 total, zero failures | `final-tests.log` |
| Expo Agent CLI typecheck | Passed, zero diagnostics | `final-typecheck.json` |
| Expo Agent CLI lint | Exit 0 | `final-lint.log` |
| Actual iOS export | Passed; 9,143,980-byte Hermes bundle, source map and platform metadata verified | `ios-export.log`, `final-exports.json` |
| Actual Android export | Passed; 9,339,072-byte Hermes bundle, source map and platform metadata verified | `android-export.log`, `final-exports.json` |
| Final-source native persistence | Seed, actual process termination/relaunch, and verification passed on the same conversation 46 | `native-seed-final.json`, `native-verify-final.json` |
| Final-source Hermes edit budgets | All 28 admission, rejection, byte-integrity and patch cases passed | `native-performance-final.json` |
| Final-source persisted native UI | Actual mounted edit card expanded; displayed diff matched committed details | `native-ui-final.json` |
| Final native error sample | Zero errors over four seconds; runtime readable | `native-errors-final.json` |
| Final-source browser persistence | Independent seed, complete profile-process shutdown, new-process reopen and verification passed; production pool and lock checks passed | `browser-seed-final.json`, `browser-restart-final.json`, `browser-verify-final.json`, `browser-policy-final.json` |
| Final browser errors | Zero page errors | `browser-errors-final.json` |
| Browser file-tool presentation | Actual component, captured durable results, expanded diff and DOM accessibility state verified at 390 by 844 | `browser-ui.json`, `browser-file-tools.png` |

Android was validated through its actual Metro/Hermes export; no Android device runtime run is claimed. Native runtime measurements came from the dedicated iOS simulator, and all model transport was scripted. These checks establish local tool behavior, persistence, presentation and compatibility, not live provider entitlement.

The dedicated browser was closed after validation. The dedicated simulator was shut down without erasing its test data; the user's original simulator was left untouched. The validation Metro process was stopped after the browser checks and platform exports completed. Existing uncommitted app work was preserved, and generated CNG native files were not edited by hand.

### Standalone physical iPhone installation

After the implementation checks, the user requested a standalone device installation followed by a commit of all outstanding repository work. Expo Agent CLI's current `status`, workflow help and `run:ios --help` were inspected, and the connected physical `iPhoneV` (iPhone 15 Pro) was selected explicitly:

```sh
npx --no-install @expo/agent-cli run:ios \
  --device 00008130-00010DEE0289001C \
  --configuration Release --no-bundler \
  --output .expo/workspace-tools-standalone-ios
```

The signed Release build succeeded with zero errors and two warnings, and installation completed at 100%. The resulting `piagent.app` is version 1.0.0 (1), bundle identifier `com.vikashloomba.piagent`, for `iPhoneOS`. Its embedded `main.jsbundle` is 11,063,362 bytes of Hermes bytecode; Expo Updates is disabled, and strict deep code-signature verification passed. Release embeds the JavaScript; `--no-bundler` prevents a development server from being started for the installation command.

With port 8081 still having no listener, `devicectl` terminated any existing app process and cold-launched the installed app. The new process remained running, and a physical-device screenshot confirmed that the Chats screen rendered with existing saved conversations. This verifies standalone installation and startup; it does not replace the earlier simulator performance measurements or establish a new live-provider inference result.

Local evidence in `.expo/file-tools-validation/`: `phone-release-install.log`, `phone-release-artifact.json`, `phone-release-cold-launch.json`, `phone-release-processes.json`, and `phone-release-cold-launch.png`. The signed application is retained at `.expo/workspace-tools-standalone-ios/piagent.app`. These generated outputs and the device screenshot remain ignored by Git.
