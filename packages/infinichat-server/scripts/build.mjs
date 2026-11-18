import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

// The server's runtime, with its tools plugin, and InfiniChat's server plugin (src/main.ts with src/tools-facet.ts,
// and src/facet.ts), each one module in dist/, both importing the packages of runtime/package.json from the runtime's
// node_modules, so the host and every plugin share one instance of each; the user's plugins get the same instances as
// host packages (src/plugins.ts). The workspace's own code is bundled into each. --check verifies that the runtime
// pins the very packages the workspace builds against. The release is package.json's version, which only InfiniChat's
// plugin holds (src/build.d.ts): no app has it, since an app compares a server with the newest release published
// (packages/infinichat/src/pi/infinichat-remote/release.ts), never with one of its own.
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check')) {
  throw new Error('Usage: node scripts/build.mjs [--check]');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const shared = Object.keys(JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8')).dependencies);
// pnpm keeps Photon among pi-durable's own dependencies; the plugin embeds the copy pi-durable's processor loads.
const durable = require.resolve('@earendil-works/pi-durable/package.json');
const photon = createRequire(durable).resolve('@silvia-odwyer/photon/photon_rs_bg.wasm');

// Each runtime package at the version the workspace has, or the bundles were built against other code. Some export no
// package.json, so each is read from this package's own direct dependency.
const installed = async (name) =>
  JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
const pins = JSON.parse(await readFile(join(root, 'runtime/package.json'), 'utf8')).dependencies;
// An alias pin, `npm:<package>@<version>`, counts by its version: the runtime's esbuild is esbuild-wasm, the one
// build that runs on every machine a release's single runtime goes to; Chord's plugins component imports `esbuild`.
const pinned = (pin) => pin.startsWith('npm:') ? pin.slice(pin.lastIndexOf('@') + 1) : pin;
for (const name of shared) {
  const have = await installed(name);
  if (have !== pinned(pins[name])) {
    throw new Error(`runtime/package.json pins ${name} ${pins[name]}; the workspace has ${have}.`);
  }
}

if (check) {
  console.log(`Verified the runtime's pins of the InfiniChat server ${version}.`);
} else {
  await rm(join(root, 'dist'), { recursive: true, force: true });
  const { metafile } = await build({
    entryPoints: {
      main: join(root, 'src/main.ts'),
      'plugins/infinichat/server': join(root, 'src/facet.ts'),
    },
    // Paths in the bundles' comments are relative to this, so every checkout builds the same bytes.
    absWorkingDir: root,
    outdir: 'dist',
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: shared.flatMap((name) => [name, `${name}/*`]),
    loader: { '.wasm': 'binary' },
    alias: { '@silvia-odwyer/photon/photon_rs_bg.wasm': photon },
    define: { INFINICHAT_SERVER_VERSION: JSON.stringify(version) },
    metafile: true,
    logLevel: 'warning',
  });
  // Every package the bundles leave as an import must be one the runtime ships.
  for (const output of Object.values(metafile.outputs)) {
    for (const { path, external } of output.imports) {
      if (!external || path.startsWith('node:')) continue;
      const name = path.startsWith('@') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
      if (!shared.includes(name)) throw new Error(`The server imports ${path}, which runtime/package.json lacks.`);
    }
  }
  // pi-claude-code starts this script, by its path beside the module that holds its code, as the MCP server through
  // which Claude Code sees pi's tools without running them (its `src/claude-cli.ts`); a bundle cannot carry it.
  await copyFile(require.resolve('@earendil-works/pi-claude-code/src/inert-mcp.mjs'),
    join(root, 'dist/plugins/infinichat/inert-mcp.mjs'));
  // The guide the agents read before they write a plugin or add an MCP server, which InfiniChat's plugin names by its
  // path in the runtime (src/extending.ts).
  await mkdir(join(root, 'dist/docs'));
  await copyFile(join(root, 'docs/extending.md'), join(root, 'dist/docs/extending.md'));
  console.log(`Built the InfiniChat server ${version} into dist/.`);
}
