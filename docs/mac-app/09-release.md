# Piece 9: Release

## Goal

A signed, notarized InfiniChat.app with updates from GitHub Releases, installed in /Applications on this Mac.

## What upstream does

- guides/code-signing: `build.mac.codesign`, `notarize`, `createDmg`; `ELECTROBUN_DEVELOPER_ID` (the keychain has
  `Developer ID Application: Vikash Loomba (BMNS2Z2BU9)`), and either `ELECTROBUN_APPLEAPIKEYPATH` +
  `ELECTROBUN_APPLEAPIKEY` + `ELECTROBUN_APPLEAPIISSUER` or `ELECTROBUN_APPLEID` + `ELECTROBUN_APPLEIDPASS` +
  `ELECTROBUN_TEAMID`; `ELECTROBUN_SKIP_NOTARIZATION=1` for a dry run. Electrobun supplies the JIT entitlements.
- guides/updates and apis/updater: `release.baseUrl`, `artifacts/` uploaded unrenamed; GitHub's
  `releases/latest/download` for stable; `Updater.checkForUpdate()`, `downloadUpdate()`, `applyUpdate()` (asks
  `before-quit`), `onStatusChange`; the first release has no patch.
- apis/application-icons: `build.mac.icons` as an `.iconset` made with `iconutil`-sized PNGs.
- guides/bundling-and-distribution: `macos-arm64-InfiniChat.dmg`, `stable-macos-arm64-update.json`,
  `stable-macos-arm64-InfiniChat.app.tar.zst`.

## Builds

- `apps/mac/icon.iconset` from `apps/mobile/assets/icon.png` (the ten sizes, `sips`).
- `electrobun.config.ts`: `build.mac: { codesign: true, notarize: true, createDmg: true, icons: 'icon.iconset' }`,
  `release: { baseUrl: 'https://github.com/VikashLoomba/expo-pi/releases/latest/download' }`; `app.version` from
  `package.json`.
- `src/main/updater.ts`: a check a few seconds after launch and on "Check for Updates…" (App menu), a message box
  offering Install and Relaunch when one is available, `downloadUpdate` then `applyUpdate`, errors reported in the
  message box; dev builds skip it (`BuildConfig.isPackaged`).
- `scripts/release.ts`: `hutch electrobun build --env=stable` with the signing variables from the environment, then
  `gh release create mac/v<version> artifacts/* --title "InfiniChat for Mac <version>"`; the version is bumped in
  `package.json` first. Tags are prefixed `mac/` so the repo's other tags never publish an app.

## Ownership and lifetime

The owner holds the notarization credentials and exports them in the shell that runs the release; nothing is written
to the repo. The release host is the repo's releases.

## Deviations

None.

## Size

About 200 lines: updater 70, release script 60, icon and config 70.

## Checks

- A stable build signs, notarizes and staples; the DMG installs to /Applications; Gatekeeper opens it; `codesign -dv`
  and `spctl -a -vv` pass.
- Publish 1.0.0, then 1.0.1: the installed app offers the update, installs it and relaunches as 1.0.1; the second
  release carries a patch.

## As built (2026-10-30)

Against Electrobun 2.0.5 through Hutch 0.28.2 (the devkit's `ElectrobunConfig.ts`, `core/Updater.ts`, `core/Utils.ts`)
and the guides code-signing, updates and apis/updater as served that day. Where it differs from the plan above:

- **The icon is an Icon Composer `InfiniChat.icon`,** not an `.iconset`: the config takes either, and an `.icon`
  compiles with `actool` into `Assets.car` for macOS 26 and later plus an `.icns` for older systems
  (`ElectrobunConfig.ts:437-449`). This Mac runs macOS 27.2, where a square full-bleed `.iconset` icon would not take
  the system's shape. Its one layer is the phone's icon (`app.json` names
  `assets/images/infinichat-icons/infinichat-floating-porcelain.png`; the plan's `apps/mobile/assets/icon.png` does not
  exist), at Icon Composer's 1024-point canvas, with no glass, shadow or translucency, so it looks as on the phone.
- **The updater needs no packaged-build check:** the Updater reports no update on the dev channel itself
  (`Updater.ts:1761`). It downloads before asking, so Install and Relaunch is immediate, and checks at launch with no
  delay; a launch check shows nothing unless an update is ready, Check for Updates… (after About) also says when the app
  is up to date or why it couldn't check.
- **An update goes through the app's own shutdown.** `applyUpdate` asks the `before-quit` handlers and takes a refusal
  as a cancel (`Utils.ts:134-161`, `Updater.ts:2302-2305`), and the app's handler refuses the first ask while it
  closes its links. The teardown is now one `shutDown` the handler and the updater share: the updater runs it, then
  `applyUpdate`, whose ask finds it under way and is allowed.
- **`scripts/release.ts`** (`hutch release`) builds from a committed tree whose commit GitHub has, since the tag names
  it; it clears `artifacts/` first so only that build's files go up, and fills `ELECTROBUN_DEVELOPER_ID` with the
  keychain's identity unless the shell names another. The version is the one committed in `package.json`.
- `scripts/` joined the Mac tsconfig's `include`, so both build scripts are typechecked.

Checked on this Mac: typecheck and lint; the dev build compiles the icon (`Assets.car`, `AppIcon.icns`,
`CFBundleIconName` InfiniChat); a stable build with `ELECTROBUN_SKIP_NOTARIZATION=1` signs every Mach-O and the app with
the Developer ID (hardened runtime, secure timestamp, `codesign --verify --deep --strict` passes, entitlements are
Electrobun's three), signs the DMG, writes `stable-macos-arm64-update.json` and skips the patch ("no previous release
found"). Not yet done: notarization, which needs the owner's App Store Connect or Apple ID credentials; the first
release, which needs this commit on GitHub; the Gatekeeper check of the downloaded DMG; and the 1.0.0 → 1.0.1 update.
Electrobun writes `CFBundleVersion` but no `CFBundleShortVersionString`.
