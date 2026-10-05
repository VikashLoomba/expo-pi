# Persistent local bash tool implementation goal

Implement the pi-durable local bash tool fully, using just-bash with MountableFs, an in-memory system root, and an Expo SQLite-backed persistent workspace. This brief is part of the active implementation goal. Its requirements must not be silently reduced, replaced by stubs, or omitted to save time. Preserve all pre-existing user work.

## Architecture and behavior

- Run just-bash on device as an interpreted shell. Keep optional JavaScript and Python execution disabled. Keep networking disabled unless a later explicit user instruction changes that scope.
- Use MountableFs with InMemoryFs for the system namespace, including /bin, /usr/bin, /dev, /proc and /tmp. Mount a custom SQLiteFileSystem at /workspace. Set default cwd and HOME to /workspace.
- Explain that /workspace persists while the system filesystem is temporary. Shell state such as cd, export and functions resets between exec calls unless deliberately managed by the wrapper.
- Register bash centrally in DurableChatService so ordinary new and reopened pi-durable chats receive it. Inspect stored tool and extension restrictions and handle them deliberately rather than accidentally omitting existing chats. Do not claim already prepared model requests gain tools retroactively.
- Prefer an idiomatic direct defineTool wrapper for bash-only integration. Evaluate any alternative use of createBashTool and ExecutionEnv against the broader filesystem, streaming and spill contract; do not claim just-bash provides native output streaming it does not expose.
- Return correct stdout, stderr, exit code, execution errors, bounded model/UI output and useful spill artifacts when appropriate. Keep tool descriptions and UI truthful about supported commands and limits.
- Use a stable saved workspace identifier per conversation, not a process-local map or only a potentially reused numeric chat ID. Initialize existing chats safely and define reopen, archive, deletion and reset behavior.
- Define fork behavior explicitly. Forks must not accidentally share mutable workspace files. A current-state copy is not a historical snapshot; either retain the versions needed for historical forks or expose and document a coherent supported policy. Do not add unrelated fork UI solely for this task.
- Shared workspaces are not a required new product feature, but concurrency must remain correct when separate executors access the same namespace.

## SQLite-backed filesystem

- Store both bytes and metadata in Expo SQLite. Use SDK-compatible installed APIs, currently Expo 58.0.2 and expo-sqlite 58.0.8, refreshed against the live checkout before implementation.
- Bind regular file data as BLOBs with Uint8Array or ArrayBuffer. Do not store bytes as base64 or serialize the whole filesystem into one JSON document.
- Begin with a separately owned pi-workspaces.db containing multiple workspace namespaces. Reuse or cleanly refactor the existing queued Expo SQLite connection driver where appropriate. Preserve Pi's storage ownership and migration boundaries.
- Separate workspaces, inodes and directory entries. Store entry type, permission bits, timestamps, size, regular-file bytes and symbolic-link targets. Directory-entry uniqueness must govern creation and rename collisions. Hard links must share inode identity, bytes and metadata. Moving a directory should not require rewriting all descendant paths.
- Implement the complete chosen just-bash IFileSystem contract: readFile, readFileBuffer, writeFile, appendFile, exists, stat, mkdir, readdir, rm, cp, mv, resolvePath, getAllPaths, chmod, symlink, link, readlink, lstat, realpath and utimes. Include useful optional readFileBytes and readdirWithFileTypes operations. Implement atomic createExclusive with virtual mode assigned in the same transaction.
- Cover UTF-8, ASCII, binary/Latin-1, base64 and hex according to the actual just-bash contract. Preserve raw bytes, Unicode, empty files and NUL bytes correctly.
- Implement correct relative, absolute, intermediate, dangling and cyclic symlink behavior; hard-link identity and reclamation; directory type and nonempty checks; recursive/force/copy/move semantics; stable metadata; and predictable POSIX-style errors.
- Keep all guest paths in the virtual namespace. Reject malformed paths and raw host URI escapes. Never expose database files or arbitrary host paths. Bind SQL values instead of constructing SQL from guest names or contents.
- Satisfy synchronous getAllPaths with an appropriate bounded metadata strategy; do not preload all file contents or repeatedly scan the whole workspace for normal operations. Current glob expansion uses asynchronous directory reads.
- Atomically update bytes and metadata for each coherent filesystem mutation in a short transaction. Exclusive creation must use namespace constraints and transactional insertion, not an unprotected exists-then-write sequence.
- Do not hold a transaction around all of bash.exec. Keep ordinary shell partial-success semantics and avoid long writer locks. A database query queue alone does not make several independent queries one atomic filesystem operation.
- Enforce explicit file-size, aggregate storage, namespace, traversal and relevant allocation quotas. Account for hard links and updates correctly. Avoid unbounded synchronous work on the app JS thread.
- Start with a maintainable one-BLOB-per-file design if evidence supports it. Assess repeated append/rewrite copies and large-file reads. Add chunking only when needed; storage chunking cannot eliminate allocations required by just-bash's whole-file API.
- Choose WAL, foreign keys, busy handling, connection isolation, synchronous durability, migration and cleanup/space-management settings deliberately. Distinguish transaction consistency, ordinary process-restart persistence and power-loss durability.
- Implement export/materialization through Expo FileSystem where necessary for the implemented artifact flow. SQLite-backed files do not have native file URLs. Do not broaden into unrelated file-browser or sharing features.

## Pi durability and app lifecycle

- General mutating bash must use replay unsafe. A crash after a file mutation but before the Pi result commit must not silently re-execute the mutation.
- File operations and Pi result commits remain separate transaction boundaries. Even placing their tables in one database file does not establish exactly-once execution or rollback. True combined atomicity requires deliberate integration and is not to be implied.
- Use sequential tool execution and appropriate workspace and database queues. Tool-round ordering is not sufficient to serialize separate chats or executors sharing storage.
- Pass the pi-durable invocation abort signal to just-bash and filesystem work. Enforce bounded deadlines, stop admitting new mutations after cancellation, and coherently drain or roll back already admitted operations on backgrounding, close, restart and failures.
- Do not return from a timeout Promise.race while uncontrolled writes continue. Preserve cancellation identity and show interrupted/partially completed execution honestly.
- Close owned connections only after admitted work settles. Reopening and sign-in/runtime transitions must not lose or incorrectly reassign workspace state.

## Native and web compatibility

- Pin and inspect the selected just-bash version and published artifact. Prior assessment inspected upstream 7537a260e38648e8998db7a95504102ad80b0194 and published 3.6.0 separately; do not assume those artifacts are identical without verification.
- Use the explicit browser entry or a maintained native-compatible build. Native Metro does not automatically select the browser export. Do not import the Node entry and fake a broad Node environment.
- Resolve the proven static node:zlib dependency in the browser bundle, including gzip and rg compressed-search paths. Runtime command allowlists do not prune Metro's import graph. Provide a small, maintainable native compatibility layer/build with supported replacements or explicit unsupported behavior.
- Audit the enabled commands against actual Hermes/React Native globals: TextEncoder/TextDecoder and fatal decoding, atob/btoa, crypto including SHA digests, Buffer, Streams, compression and timers. Override or omit unsupported commands/options honestly. Preserve useful commands where practical; do not cut the shell to a trivial subset to pass a probe.
- The assessed browser build omits tar, yq, xan and sqlite3 as well as JS/Python loaders. Do not advertise omitted functionality. Expo SQLite as host storage does not enable the shell sqlite3 command or require just-bash's Node/WASM runtime.
- Browser builds do not have the Node defense-in-depth layer. Rely on verified interpreter behavior, restricted capabilities, filesystem containment and execution/resource limits rather than claiming unavailable isolation.
- Set phone-appropriate source, operation/work, execution-time, memory, output and storage limits. Validate adversarial input and responsiveness; cooperative cancellation does not mean arbitrary CPU work is preemptible.
- Preserve and support the app's web target where practical with the SQLite adapter. Verify browser persistence and concurrency separately; Expo SQLite web requires WASM and cross-origin isolation, and withExclusiveTransactionAsync is unavailable there. Use correct owned-connection serialization rather than assuming native-only APIs work on web.

## Required engineering quality and adversarial review

The implementation must be adversarially reviewed for all four user requirements:

1. Idiomatic implementation for this Expo, React Native and Pi codebase.
2. Reasonable abstractions, explicit ownership and lifecycle boundaries, without speculative overengineering.
3. Good organization across modules, folders and files. Avoid monolithic filesystem, tool, compatibility or test modules; keep responsibilities cohesive.
4. Readability and ease of understanding for future human reviewers and agent maintainers. Do not make a mess. Clean up directly related existing tangled code when encountered, preserving behavior and user work; avoid unrelated rewrites.

Use independent reviewers who inspect the actual changed and relevant unchanged code paths. Reviews must also challenge binary correctness, namespace containment, transaction atomicity, concurrency, quotas, recovery, cancellation, supported-command claims and test evidence. Fix substantive findings and obtain focused re-review as needed. Do not satisfy this requirement with a self-review or a generic checklist alone.

## Validation and delivery

- Follow AGENTS.md, relevant package skills, matching current Expo documentation and Expo Agent CLI workflows. Preserve the dirty checkout. Never hand-edit generated CNG native directories.
- Add meaningful filesystem conformance and integration coverage against real SQLite, including encodings and binary bytes, redirection/appends, metadata, directory rules, error codes, links and identity, exclusive creation, quotas, concurrent access, cancellation, failed transaction/migration rollback, reopen/restart and workspace lifecycle/forks.
- Verify tool availability for new and reopened chats, ordinary and failing commands, output limits, unsafe recovery and background/service-close behavior through the real pi-durable integration.
- For claims of end-to-end real provider behavior, use a real provider with a runtime-entered user credential. Never commit/bundle credentials or substitute fixtures for real-provider evidence. Isolated deterministic tests remain useful but must be labeled accurately.
- Run required lint/typecheck, relevant existing regressions, actual iOS and Android Metro/Hermes export gates, and native runtime/cold-restart tests for persistent bytes and metadata where the environment permits. Verify web separately.
- Distinguish source/test success, bundle/compile success, actual native behavior and environmental blocks. A mocked test, syntax compilation or source scan does not prove native persistence or complete runtime correctness.
- Deliver complete code, architecture and maintenance documentation, review findings and fixes, and evidence-based test results with genuine limitations identified. Do not mark the goal complete with required work outstanding or silently convert full implementation into a stub or feasibility report.
