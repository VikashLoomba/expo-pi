import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

if (process.argv.length > 2) throw new Error('Usage: node scripts/build-infinichat-server.mjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
// pnpm keeps Photon among pi-durable's own dependencies; the bundle embeds the copy pi-durable's processor loads.
const durable = require.resolve('@earendil-works/pi-durable/package.json');
const photon = createRequire(durable).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm');

await build({
  entryPoints: [join(root, 'server/main.ts')],
  outfile: join(root, 'dist/infinichat-server/server.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  loader: { '.wasm': 'binary' },
  alias: { '@silvia-odwyer/photon/photon_rs_bg.wasm': photon },
  // Some SDKs pi-ai bundles call require(), which an ES module lacks (pi-ai README, "Bundling and Tree Shaking").
  banner: { js: 'import { createRequire } from "node:module";const require = createRequire(import.meta.url);' },
  logLevel: 'info',
});
