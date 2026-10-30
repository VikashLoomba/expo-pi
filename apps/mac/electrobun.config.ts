import type { ElectrobunConfig } from 'electrobun';

import pkg from './package.json' with { type: 'json' };

export default {
  app: {
    name: 'InfiniChat',
    identifier: 'com.vikashloomba.piagent.mac',
    version: pkg.version,
  },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'src/main/index.ts' },
    views: { app: { entrypoint: 'src/view/index.tsx' } },
    copy: {
      'src/view/index.html': 'views/app/index.html',
      // The Settings window's page: the same bundle, told which window it is.
      'src/view/settings.html': 'views/app/settings.html',
      // Compiled by scripts/pre-build.ts from src/view/app.css.
      'build-css/app.css': 'views/app/app.css',
      // A single-file bundle cannot resolve Photon's package, so the main process reads its own copy
      // (pi-durable `images/node`).
      'node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm': 'photon/photon_rs_bg.wasm',
      // The pi-env daemons this Mac's own connections deploy (`machines.ts`), the same files the phone ships.
      'node_modules/@pi-agent/infinichat-server/assets/pi-env': 'server/pi-env',
    },
    watch: ['../../packages/infinichat/src'],
    mac: {
      // Canary and stable builds are signed with the Developer ID and notarized; dev builds skip both
      // (guides/code-signing). The signing identity and Apple's credentials come from the release's environment.
      codesign: true,
      notarize: true,
      // Icon Composer's file, made from the phone's icon: Liquid Glass on macOS 26 and later, an .icns before.
      icons: 'InfiniChat.icon',
    },
  },
  // Stable releases on GitHub; `latest/download` follows the newest release, never a prerelease (guides/updates).
  release: { baseUrl: 'https://github.com/VikashLoomba/expo-pi/releases/latest/download' },
  // A Mac app stays open without windows; the Dock reopens one.
  runtime: { exitOnLastWindowClosed: false },
  scripts: { preBuild: './scripts/pre-build.ts' },
} satisfies ElectrobunConfig;
