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
