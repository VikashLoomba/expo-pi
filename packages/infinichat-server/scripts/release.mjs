import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Publishes the server as a release of this repository on GitHub, tagged `server/v<version>` and never marked latest:
// `latest/download` serves the Mac app's updates (apps/mac/electrobun.config.ts). A release is a runtime, the Chord
// host (dist/main.js) with the packages it and every plugin share, installed exactly as runtime/package-lock.json
// locks them and named by a hash of the two, and InfiniChat's server plugin (dist/plugins/infinichat/server.js). Each
// machine's server updates itself to the newest release and restarts into it, downloading only the plugin while its
// runtime is the same (packages/infinichat-server/src/update.ts). Run `pnpm release` here after committing the version
// in package.json and pushing that commit, which the tag names.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8' }).trim();
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
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
run('node', ['scripts/build.mjs', '--check']);
run('node', ['scripts/build.mjs']);

const folder = await mkdtemp(join(tmpdir(), 'infinichat-server-release-'));
try {
  const stage = join(folder, 'runtime');
  await mkdir(stage);
  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(join(root, 'runtime', file), join(stage, file));
  }
  await copyFile(join(root, 'dist/main.js'), join(stage, 'main.js'));
  // The packages as locked, without install scripts, as the workspace builds none of them either.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
  const key = createHash('sha256').update(await readFile(join(stage, 'package-lock.json')))
    .update(await readFile(join(stage, 'main.js'))).digest('hex').slice(0, 32);
  const runtime = join(folder, `runtime-${key}.tar.gz`);
  // Without macOS's metadata, which Linux's tar would only warn about.
  const metadata = process.platform === 'darwin' ? ['--no-mac-metadata'] : [];
  run('tar', [...metadata, '--no-xattrs', '--no-acls', '-czf', runtime, '-C', stage, '.'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const plugin = join(folder, 'infinichat.js');
  await copyFile(join(root, 'dist/plugins/infinichat/server.js'), plugin);
  const release = join(folder, 'release.json');
  await writeFile(release, JSON.stringify({
    version, runtime: { key, sha256: await sha256(runtime) }, plugin: { sha256: await sha256(plugin) },
  }, null, 2));
  run('gh', ['release', 'create', tag, '--target', commit, '--title', `InfiniChat server ${version}`, '--notes', '',
    '--latest=false', runtime, plugin, release]);
} finally {
  await rm(folder, { recursive: true, force: true });
}
