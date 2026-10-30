import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publishes the server as a release of this repository on GitHub, tagged `server/v<version>` and never marked latest:
// `latest/download` serves the Mac app's updates (apps/mac/electrobun.config.ts). Each machine's server updates itself
// to the newest release, and an app sets one up from it on a machine that has none
// (packages/infinichat/src/pi/infinichat-remote/release.ts). Run `pnpm release` here after committing the version in
// package.json and the build it gives, and pushing that commit, which the tag names.
const root = fileURLToPath(new URL('../', import.meta.url));
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const tag = `server/v${version}`;
if (read('git', ['status', '--porcelain'])) {
  throw new Error('Commit your changes first: the release is built from its tag.');
}
const commit = read('git', ['rev-parse', 'HEAD']);
run('git', ['fetch', '--quiet', 'origin']);
if (!read('git', ['branch', '--remotes', '--contains', commit])) {
  throw new Error(`Push ${commit.slice(0, 7)} to GitHub first: the release's tag ${tag} names it.`);
}
// The committed build and daemons are the release: both checks fail when they don't match the sources and pins.
run('node', ['scripts/build.mjs', '--check']);
run('node', ['scripts/sync-daemons.mjs', '--check']);

const folder = await mkdtemp(join(tmpdir(), 'infinichat-server-release-'));
try {
  const files = [join(folder, 'server.js'), ...targets.map((target) => join(folder, `pi-env-${target}`))];
  await copyFile(join(root, 'assets/server.bin'), files[0]);
  for (const target of targets) {
    await copyFile(join(root, `assets/pi-env/pi-env-${target}.bin`), join(folder, `pi-env-${target}`));
  }
  const daemons = Object.fromEntries(await Promise.all(targets.map(async (target) =>
    [target, await sha256(join(folder, `pi-env-${target}`))])));
  const manifest = join(folder, 'manifest.json');
  await writeFile(manifest, JSON.stringify({ version, sha256: await sha256(files[0]), daemons }, null, 2));
  run('gh', ['release', 'create', tag, '--target', commit, '--title', `InfiniChat server ${version}`, '--notes', '',
    '--latest=false', ...files, manifest]);
} finally {
  await rm(folder, { recursive: true, force: true });
}
