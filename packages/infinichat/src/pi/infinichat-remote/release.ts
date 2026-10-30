import { Type, type Static } from '@earendil-works/pi-ai';
import { Check } from 'typebox/value';

/**
 * InfiniChat's server releases: the GitHub releases of this repository tagged `server/v<version>`, which
 * `packages/infinichat-server/scripts/release.mjs` publishes, never marked latest, so `latest/download` keeps serving
 * the Mac app's updates. A server updates itself to the newest one, and an app sets one up from it on a machine that
 * has none; nothing else installs a server.
 */
const REPOSITORY = 'VikashLoomba/expo-pi';
const TAG = /^server\/v(\d+\.\d+\.\d+)$/;
/** pi's own wait for a catalog fetch, as `pi-catalog.ts` bounds each. */
const ATTEMPT_MS = 4_000;

/** The systems a release carries a pi-env daemon for, as pi-env's package names them. */
export const DAEMON_TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'] as const;
export type DaemonTarget = typeof DAEMON_TARGETS[number];

const Hash = Type.String({ pattern: '^[0-9a-f]{64}$' });
/** A release's `manifest.json`: its version, and the SHA-256 of `server.js` and of each `pi-env-<target>`. */
const ServerReleaseSchema = Type.Object({
  version: Type.String(),
  sha256: Hash,
  daemons: Type.Object({ 'darwin-arm64': Hash, 'darwin-x64': Hash, 'linux-arm64': Hash, 'linux-x64': Hash }),
});
export type ServerRelease = Static<typeof ServerReleaseSchema>;
/** The fields of GitHub's release list this reads. */
const ReleasesSchema = Type.Array(Type.Object({
  tag_name: Type.String(), draft: Type.Boolean(), prerelease: Type.Boolean(),
}));

/** A release file's address; GitHub serves a tag's slash as it is. */
export const releaseFile = (version: string, name: string) =>
  `https://github.com/${REPOSITORY}/releases/download/server/v${version}/${name}`;

const parts = (version: string) => version.split('.').map(Number);

/** Below zero when `left` is older than `right`, above when newer. */
export function compareVersions(left: string, right: string): number {
  const [a, b] = [parts(left), parts(right)];
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

async function json(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(ATTEMPT_MS)]),
  });
  if (!response.ok) throw new Error(`InfiniChat’s server releases could not be read (${response.status}).`);
  return response.json();
}

/** The newest server release, or undefined when there is none. */
export async function latestServerRelease(signal: AbortSignal): Promise<ServerRelease | undefined> {
  const listed = await json(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`, signal);
  if (!Check(ReleasesSchema, listed)) throw new Error('InfiniChat’s server releases could not be read.');
  let newest: string | undefined;
  for (const release of listed) {
    const version = release.draft || release.prerelease ? undefined : TAG.exec(release.tag_name)?.[1];
    if (version !== undefined && (newest === undefined || compareVersions(version, newest) > 0)) newest = version;
  }
  if (newest === undefined) return undefined;
  const manifest = await json(releaseFile(newest, 'manifest.json'), signal);
  if (!Check(ServerReleaseSchema, manifest) || manifest.version !== newest) {
    throw new Error(`InfiniChat’s server release ${newest} has no valid manifest.`);
  }
  return manifest;
}
