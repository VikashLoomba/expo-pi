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
      'src/view/app.css': 'views/app/app.css',
      // A single-file bundle cannot resolve Photon's package, so the main process reads its own copy
      // (pi-durable `images/node`).
      'node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm': 'photon/photon_rs_bg.wasm',
      // The server bundle and the pi-env daemons an install uploads, the same files the phone ships.
      'node_modules/@pi-agent/infinichat-server/assets': 'server',
    },
    watch: ['../../packages/infinichat/src'],
  },
  // A Mac app stays open without windows; the Dock reopens one.
  runtime: { exitOnLastWindowClosed: false },
} satisfies ElectrobunConfig;
