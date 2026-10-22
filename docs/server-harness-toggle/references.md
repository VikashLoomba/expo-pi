# References

Checked on 2026-10-21. Versions:
- **pi:** 1.3.0 installed; the target is 1.4.0, published to npm at 22:44 UTC that day (tag `4a080252f`).
- **App:** Expo 58.0.14, React Native 0.88 with Hermes 260318099.0.4, react-native-ssh 0.3.0.

`file:line` references are at those versions unless stated otherwise.

## Upstream contracts

| Contract | Source |
| --- | --- |
| A Chord server host owns the Durable Harness; clients get a reference | chord `docs/guide.md:756` "Durable", `:712` "Hosts and links" |
| A `Chat` object exposing `view`, `send`, `stop` per principal | chord `docs/guide.md:367` |
| Mirroring an external store into a cell with `replace`, sent as a diff | chord `docs/guide.md:444` |
| A held reference keeps its last values while a link reconnects; calls wait until live | chord `docs/guide.md:396` "References" |
| `host.connect(link)` replaces the link after a reconnect | chord `src/host.ts:231` |
| Links don't resume: a dropped link releases its holds, re-holds are new | chord `docs/spec.md:260` |
| `acceptWebSockets` hard-codes `compress: true` | chord `src/websocket.ts:26` |
| Payloads over 64 KiB are deflated; browsers inflate with `DecompressionStream` | chord `src/link.ts:113`, `:229` |
| `Link` interface | chord `src/link.ts:5-18` |
| `processLock`: kernel-owned, taken before opening storage | chord `src/manager.ts:76-82` (`@earendil-works/chord/node`) |
| One process owns a storage; no cross-process locking | pi-durable `README.md:790` |
| Work interrupted by a crash or close stays pending | pi-durable `README.md:127` |
| A clean close writes stopped tasks back as pending, uncounted | pi-durable `CHANGELOG.md:22` (1.4.0) |
| `watch()` is meant for remote clients; a late joiner starts from the current view | pi-durable `README.md:495` |
| `HarnessOptions.models`: a `Models` or a function returning one | pi-durable `src/harness/types.ts:616` |
| Host-injected `CredentialStore`; refresh serialized inside `modify` | pi-ai `README.md:456` |
| `models.login` with a relayed `prompt`/`notify`; `manual_code` races the local callback | pi-ai `README.md:1785`, `:1808` |
| Credentials stay with the Durable worker | pi-env `README.md:4` |
| `connectSsh`, `sshConnection`, `scanHostKey`, `acceptHostKey`, `binary` | pi-env `src/ssh.ts:355-359`, `:464-472`, `:519-532` |
| Node ≥ 22.19 and built-in `node:sqlite` | pi-durable and chord `package.json` `engines`; chord `src/sqlite/node.ts:3-4` |
| Local port forwarding for WebSocket clients | react-native-ssh `README.md:16-20`, `:87-93`; `src/index.ts:146-156` |
| `exec` output is capped at 16 MiB; `exec` has no stdin | react-native-ssh `src/errors.ts:20`, README "Planned" |
| `WebSocket(url, protocols, { headers })` | react-native `Libraries/WebSocket/WebSocket.js:100` |

## Chord over WebSocket in Hermes

**Probe, 2026-10-21.**
- **Server:** a Node 25 process with a Chord host and a real pi-durable 1.3.0 Harness (faux model) serving the root
  conversation's view with `send` and `stop`, mirroring the view into a cell as piece 1 does.
- **Client:** the same contract in the running app's Hermes runtime (simulator, dev build).
- **Not committed:** the probe was scratch code.

| Check | Result |
| --- | --- |
| Chord's host, link and WebSocket modules in the app bundle | Already bundled and initialized; pi-durable pulls them in |
| Hermes globals | `WebSocket`, `TextEncoder`/`TextDecoder`, `AbortSignal.any`, `WeakRef`, `structuredClone`, `ReadableStream`/`WritableStream`/`TransformStream` present; `CompressionStream`, `DecompressionStream`, `Blob.prototype.stream` missing |
| Hydrating an 81 KB view over a plain link | OK |
| Sending from the app | Admitted on the server; the answer streamed back as diffs |
| Socket dropped, then `host.connect(newLink)` | Reference went `loading` with its last values, then `live`, and caught up on a message sent meanwhile |
| Chord's own `acceptWebSockets` | The 81 KB snapshot arrived as a 950-byte deflated binary frame (seen from Node); in Hermes the `get` never resolved |

**Documentation agrees.**
- The Expo SDK 58 reference for the `expo` package lists the web globals Expo installs on native, with no
  compression streams ([docs](https://docs.expo.dev/versions/v58.0.0/sdk/expo/)). Expo's
  `src/winter/runtime.native.ts` matches, in 58.0.14 and 58.0.17.
- Nothing about compression streams in:
  - the SDK 58 changelog (2026-10-15);
  - the React Native 0.88 post (2026-10-19);
  - Hermes's contrib extensions (`TextDecoder` only);
  - issues and pull requests in expo/expo, react/react-native and facebook/hermes.

## Upstream session sync

A subagent's assessment of branch `replication` at `2cf6cd898`, 2026-10-21. It is not in v1.4.0, and not on `main`.

- **Size:**
  - `src/sync/*`: 895 lines.
  - Storage-side log and replay: +634 lines.
  - Tests: +1,366 lines.
  - Together about 5% of pi-durable's source.
- **Maturity:**
  - The relevant tests pass: 101 of 101, with the full suite otherwise green.
  - The storage layer (`log`, `replay`, `head` on every built-in storage) is well covered.
  - The sync protocol has no spec.
  - `FileSystemSyncRemote` is the only remote, and is meant for development.
  - Batches hard-code gzip through `CompressionStream`, so they can't run on the phone.
  - Found gaps: no IndexedDB migration, a spurious fork after lost sync state, and a half-finished pull that can
    corrupt silently if a Harness opens before it completes.
- **Activity:**
  - One author, four commits in about ten hours.
  - Redesigned three times in about 34 hours.
  - No pull request.
  - Its changelog lines sit in the already-released 1.4.0 section.
  - It targets the maintainers' private app.
- **Judgment:** still being designed. For a one-side-at-a-time handoff, the useful upstream part will be the
  storage layer's `log(otherHead)` → `replay`, once released. Don't run the branch on real data, because of its
  unreleased schema v3.

## Measurements

| What | Value |
| --- | --- |
| Probe server bundled into one ESM file (pi-durable, pi-ai, Chord, `ws`) | 1.2 MB, 225 KB gzipped; runs on Node |
| Same, as a Bun-compiled executable (darwin-arm64) | 62 MB (not used: Node is required instead) |
| Official Node 22 tarballs (darwin-arm64, linux-x64) | 26 MB, 31 MB (not used) |
| The phone's InfiniChat database, 2026-10-21 backup | 32 MB, plus a 4.1 MB WAL |

## Unverified until a piece checks it

- App Transport Security for `ws://127.0.0.1` through `forwardLocal` on a Release build (piece 3).
- Linux user services without lingering (piece 2).
- The ChatGPT receiver answering a server's `manual_code` prompt (piece 4).
- Move timings on the real database (piece 5).
- Whether the native web-search wrapper in `createChatModels` reaches InfiniChat requests at all. Check
  `src/pi/native-web-search/bindings.ts` when building piece 1's `server/models.ts`.
