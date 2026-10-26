# Piece 1: Fix the leaks

## Goal

Every file that piece 2 moves imports only pi packages and other moved files, and every file that stays behind is
named. Piece 2 is then a pure move. Nothing changes at run time.

## Starts from

- The import walk from `server/main.ts` ([references](references.md#the-shared-set)): 35 files that import only pi
  packages, and one type-only import of `src/pi/secure-storage.ts`, which imports `expo-secure-store`.
- `src/pi/infinichat/devices.ts` sits in the OptChat folder but builds the phone's devices: it imports
  `execution/remote/hosts`, `execution/remote/owner`, `workspace/execution-env` and `workspace/storage`. Its only user
  is `src/pi/infinichat-phone.ts:11`.

## Builds

### `CredentialBackend` moves to its shared user

`CredentialBackend` (`src/pi/secure-storage.ts:4-8`) is the persistence seam of `ProviderCredentialStore`
(`provider-credentials.ts:82`). Its file also creates the Keychain backend, so importing the interface reaches
`expo-secure-store`.

- Move the interface into `src/pi/provider-credentials.ts`, which piece 2 moves into the package.
- `secure-storage.ts` keeps `createCredentialBackend` and imports the interface from `provider-credentials.ts`.
- Update the other two type-only importers:
  - `server/credentials.ts:6`, the server's file backend;
  - `src/pi/execution/remote/hosts.ts:3`.

### The phone's devices leave the OptChat folder

Move `src/pi/infinichat/devices.ts` beside its user, to `src/pi/infinichat-phone-devices.ts`, and update
`infinichat-phone.ts:11`. Every file left in `src/pi/infinichat/` then moves in piece 2, so the folder moves as a unit.

### What stays in the app

These files sit in folders that piece 2 partly moves. They stay in the iOS app:

| Folder | Stays in the app |
| --- | --- |
| `src/chat/` | `chat-provider.tsx`, `infinichat-avatar.ts`, `photo-attachments.ts`, `shown-infinichat.ts`, `provider-account.ts` |
| `src/pi/native-web-search/` | `provider.ts` |
| `src/pi/openai-auth/` | `browser.ts`, `installation.ts`, `index.ts` |
| `src/pi/workspace/` | `execution-env.ts`, `device-storage.ts`, `storage.ts`, `files.ts` |
| `src/pi/infinichat-remote/` | `client.ts`, `move.ts`, `install.ts`, `home.ts`, `server-assets.ts`, `server-manifest.ts` (pieces 3 and 4 split the first four) |

The ordinary-chat modules that `chat-view.ts` and `chat-projection.ts` reach (`native-web-search/*` except
`provider.ts`, `execution/document.ts`, `chat/file-tool-presentation.ts`, `chat/web-search-*.ts`) import only pi
packages. They move with the view as they are. Don't separate InfiniChat's view from the chat projection: no product
requirement asks for it, and the Mac app's ordinary chats will need the same projection.

## Ownership and lifetime

Unchanged. No resource is created, borrowed or closed differently.

## Deviations (need approval)

None.

## Size

About 10 lines changed, plus one file renamed.

## Checks

- `npx @expo/agent-cli lint`, `npx @expo/agent-cli typecheck`, `pnpm exec tsc -p server`.
- `node scripts/build-infinichat-server.mjs --check`. The server's only change is a type-only import, which esbuild
  erases, so the asset should be unchanged; if `--check` fails, rebuild it in the main checkout.
- No device check of its own: nothing runs differently. Piece 2's device check covers it.

## Not in this piece

Moving files into a package (piece 2) and any new seam (pieces 3 and 4).

## As built

Built at `c796849` and the commit after it, from `c0bc61b`, with pi 1.4.0 (pi-durable, pi-ai, chord and pi-env; the
latest on npm on 2026-10-26), Expo 58.0.17 and React Native 0.88.0. Both steps went as planned: 9 lines added and 9
removed to move `CredentialBackend`, and 7 import lines rewritten for the rename, which `git` records as a rename.

What differs from the plan:

- **The interface's comment.** "Production uses the device Keychain/Keystore" no longer described every backend once
  the interface sat in a file the server bundles, so it now names both that exist: the phone's Keychain and the
  server's file.
- **Piece 2 rewrites 51 importers, not 48.** The three files that imported `CredentialBackend` from
  `secure-storage.ts` (`secure-storage.ts` itself, `server/credentials.ts` and `src/pi/execution/remote/hosts.ts`) now
  import it from `provider-credentials.ts`, which is in the shared set, so they join the
  [importers](references.md#the-48-importers); `src/pi/infinichat/devices.ts` is now
  `src/pi/infinichat-phone-devices.ts`. A scan following relative and `@/` imports, like the one in
  [references](references.md#the-shared-set), finds 51.
- **The shared set is 5,343 lines.** The same 35 files; `provider-credentials.ts` gained the interface's 5 lines net.
  None of the 35 imports anything but pi packages and each other, and the 9 files left in `src/pi/infinichat/` are
  exactly the OptChat core in the shared set, so the folder moves as a unit.

Choices:

- `secure-storage.ts` doesn't re-export the interface: every importer was updated, so a re-export would have no
  caller.
- The interface sits at the top of `provider-credentials.ts`, where its import was.
- Imports in `infinichat-phone.ts` and the moved file stay in the order the rest of the app uses.

Checks, run before each step's commit:

- `npx @expo/agent-cli lint`: no problems.
- `npx @expo/agent-cli typecheck`: no type errors.
- `pnpm exec tsc -p server`: no errors.
- `node scripts/build-infinichat-server.mjs --check`: passes on both steps. Before the second step's commit the asset
  was also rebuilt in the main checkout, then checked: the same bytes as before (8,339,531 bytes, SHA-256
  `2866fb2e…62df27`), so nothing to commit and no reinstall on any machine.
- The package's lint: not yet, since piece 2 creates the package.

Unverified: no Metro bundle was built and nothing ran on a device. As planned, piece 1 has no device check of its own;
piece 2's covers it.
