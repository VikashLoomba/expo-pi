# Handoff: the app's EAS builds

Written 2026-11-16 for the agent that continues on the owner's Linux machine while the Mac is off. Delete this file
when both builds below succeed; AGENTS.md, "Building with EAS", is where the lasting guidance is.

## What the owner asked for

"I want to use EAS for the expo mobile app to get the app up on testflight, and also be able to develop from
vikash-system when this mac is offline, using eas simulators support."

## What is in place

- The app is linked to the EAS project `pi-agent` (`extra.eas.projectId` in `apps/mobile/app.json`). Apple's side is
  set up from the owner's first run: distribution certificate and provisioning profiles for the app and its widget
  extension, an App Store Connect key on EAS, the App Store Connect app (`ascAppId` in `eas.json`) and a TestFlight
  group. Both machines are signed in to Expo; Expo Simulators is enabled for the account.
- `apps/mobile/eas.json`: `production` (store) and `development-simulator` (unsigned development build), with pnpm
  pinned to 10.33.0, because the build image's pnpm 11 fails the install (`ERR_PNPM_IGNORED_BUILDS`).
- `apps/mobile/scripts/eas-build-pre-install.sh` installs Rust on the builder and builds the SSH library's archive
  before the pods. It works: the device build compiled and linked with it.
- `apps/mobile/.fingerprintignore` keeps the SSH library's build outputs out of the fingerprint. The Mac and this
  machine compute the same fingerprint for the same commit.
- This checkout is installed (`PATH=$HOME/.bun/bin:$PATH CI=true pnpm install --frozen-lockfile`; bun is not on
  the login PATH here, and the SSH library's `prepare` needs it). The server package's lint, typecheck and `check`
  pass here.

## What failed, and where each stands

1. **Simulator build `60721c7e`: link error, fixed.** `ld: library 'rnssh_ffi' not found`, after
   `[CP] RnsshFFI.xcframework: Unable to find matching slice in 'ios-arm64 ios-arm64-simulator'`. EAS builds the
   simulator app for the generic simulator, which includes Intel, and the archive had no x86_64 simulator slice. The
   hook now adds the `x86_64-apple-ios` target, which makes the library's script build that slice. Build `d432c9e5`
   finished with it, and ran on a remote simulator from this machine through Metro's tunnel (2026-11-16).
2. **Store build `6bb26858` (build number 2): archive fine, export failed. Diagnosed, fix in place, no store build
   since.** `error: exportArchive No signing certificate "Mac App Distribution" found`, exit status 70. Every target
   in the Xcode log was built for `iphoneos`, so no target or Catalyst setting is at fault. The app bundled the
   pi-env daemons as Metro assets, and the two for macOS are Mach-O programs: the export re-signs what it finds in
   the app and asks for a Mac certificate for them (the same error as firebase-ios-sdk issue 5403). EAS does not
   upload Xcode's distribution log, so the next store build is the first direct proof. The phone now bundles the
   daemons gzipped (AGENTS.md, "Building with EAS"); a release bundle made here holds no Mach-O file, and on the
   simulator all four inflate to their manifest's size and SHA-256.
3. **A warning in the same log, open.** `The CFBundleVersion of an app extension ('1') must match that of its
   containing parent app ('2')`: expo-widgets gives its target `CURRENT_PROJECT_VERSION` from the app config and
   `GENERATE_INFOPLIST_FILE`, and EAS's remote version reaches only the `Info.plist` files. The archive succeeded
   with it; see what App Store Connect says at the first upload before doing anything about it.

## Working with builds from here

- Run EAS from `apps/mobile`: `npx eas-cli@latest build:list --limit 5`, `build:view <id> --json`.
  `npx @expo/agent-cli inspect:build-log` says what failed in a build log. The `logFiles` URLs are brotli-compressed
  JSON lines.
- TestFlight: `npx eas-cli@latest build -p ios --profile production --auto-submit --non-interactive --no-wait`.
  Every build uses the owner's build minutes and the next store build takes a new build number, so find the cause
  first and build once.
- The simulator loop is in AGENTS.md. The remote simulator is not on the owner's network, so the app reaches no
  machine over SSH there.
- The first build's App Store Connect upload has not happened yet; when a store build succeeds, check the
  submission (`eas submit:list -p ios --json`) and say how far it got, not just that it was queued.

## Builds started last

- Simulator build with the x86_64 fix: `d432c9e5-0b90-4b41-a361-1ecf6e568f61`, finished. It serves until native code
  changes (`npx @expo/agent-cli status`).
- No store build has been started since `6bb26858`.
