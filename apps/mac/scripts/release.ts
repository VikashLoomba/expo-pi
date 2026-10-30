// Publishes the stable Mac app as a release of this repository on GitHub, where `release.baseUrl` serves its updates
// from (docs/mac-app/09-release.md). Run `hutch release` in apps/mac after committing the version in package.json and
// pushing that commit, which the tag `mac/v<version>` names: a stable artifact is built from its own tag
// (guides/updates). Apple's notarization credentials come from the shell: ELECTROBUN_APPLEAPIKEYPATH,
// ELECTROBUN_APPLEAPIKEY and ELECTROBUN_APPLEAPIISSUER, or ELECTROBUN_APPLEID, ELECTROBUN_APPLEIDPASS and
// ELECTROBUN_TEAMID; Hutch names the missing ones.
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pkg from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
/** The keychain's signing identity, unless the shell names another. */
const IDENTITY = 'Developer ID Application: Vikash Loomba (BMNS2Z2BU9)';

function read(command: string[]): string {
  const result = Bun.spawnSync(command, { cwd: root, stdout: 'pipe', stderr: 'inherit' });
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${result.exitCode}.`);
  return result.stdout.toString().trim();
}

function run(command: string[], env: Record<string, string> = {}): void {
  const result = Bun.spawnSync(command, {
    cwd: root, stdout: 'inherit', stderr: 'inherit', env: { ...process.env, ...env },
  });
  if (result.exitCode !== 0) throw new Error(`${command.join(' ')} failed with exit code ${result.exitCode}.`);
}

const tag = `mac/v${pkg.version}`;
if (read(['git', 'status', '--porcelain'])) {
  throw new Error('Commit your changes first: the release is built from its tag.');
}
const commit = read(['git', 'rev-parse', 'HEAD']);
run(['git', 'fetch', '--quiet', 'origin']);
if (!read(['git', 'branch', '--remotes', '--contains', commit])) {
  throw new Error(`Push ${commit.slice(0, 7)} to GitHub first: the release's tag ${tag} names it.`);
}
// Only this build's files go up, as Hutch names them: the updater asks for these names under `release.baseUrl`.
rmSync(join(root, 'artifacts'), { recursive: true, force: true });
run(['hutch', 'electrobun', 'build', '--env=stable'],
  { ELECTROBUN_DEVELOPER_ID: process.env.ELECTROBUN_DEVELOPER_ID ?? IDENTITY });
const artifacts = readdirSync(join(root, 'artifacts')).map((name) => join('artifacts', name));
run(['gh', 'release', 'create', tag, '--target', commit, '--title', `InfiniChat for Mac ${pkg.version}`, '--notes', '',
  ...artifacts]);
// The built app is published; left here, Launch Services opens it for "InfiniChat" in place of the installed one, and
// it then records itself as the installation (2026-10-30).
rmSync(join(root, 'build', 'stable-macos-arm64'), { recursive: true, force: true });
