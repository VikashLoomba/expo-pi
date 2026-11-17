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

1. **Simulator build `60721c7e`: link error, fix pushed, not yet proven.** `ld: library 'rnssh_ffi' not found`,
   after `[CP] RnsshFFI.xcframework: Unable to find matching slice in 'ios-arm64 ios-arm64-simulator'`. EAS builds
   the simulator app for the generic simulator, which includes Intel, and the archive had no x86_64 simulator
   slice. The hook now adds the `x86_64-apple-ios` target, which makes the library's script build that slice. A new
   simulator build was started with the fix; see "Builds started last" below, or `eas build:list`.
2. **Store build `6bb26858` (build number 2): archive fine, export failed. Not diagnosed.**
   `error: exportArchive No signing certificate "Mac App Distribution" found` /
   `No "Mac App Distribution" signing certificate matching team ID ... with a private key was found`, exit status
   70. The provisioning profile mapping listed both bundle ids. Something makes the export treat a product as a Mac
   app; the widget extension target (`expo-widgets`, target `ExpoWidgetsTarget`) and Mac Catalyst or
   "Designed for iPad" settings are where to look first. Read Expo's docs and the Xcode log before changing
   anything (`artifacts.xcodeBuildLogsUrl` in `eas build:view <id> --json`).

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

Filled in when this was handed over:

- Simulator build with the x86_64 fix: see the first `development-simulator` entry of `eas build:list`.
