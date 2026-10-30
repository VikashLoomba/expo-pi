import { Type, type Static } from '@earendil-works/pi-ai';
import { Check } from 'typebox/value';

/**
 * InfiniChat's server releases: the GitHub releases of this repository tagged `server/v<version>`, which
 * `packages/infinichat-server/scripts/release.mjs` publishes, never marked latest, so `latest/download` keeps serving
 * the Mac app's updates. A release is a runtime, the Chord host (`main.js`) and the packages it and every plugin
 * share (`node_modules`), and InfiniChat's server plugin. A server updates itself to the newest one and restarts into
 * it, downloading only the plugin while the runtime stays the same; an app sets one up on a machine that has none.
 */
const REPOSITORY = 'VikashLoomba/expo-pi';
const TAG = /^server\/v(\d+\.\d+\.\d+)$/;
/** pi's own wait for a catalog fetch, as `pi-catalog.ts` bounds each. */
const ATTEMPT_MS = 4_000;

const Hash = Type.String({ pattern: '^[0-9a-f]{64}$' });
/**
 * A release's `release.json`: its version; its runtime, named by `key`, a hash of what it holds, so releases that
 * share one share its folder; and the SHA-256 of each file.
 */
export const ServerReleaseSchema = Type.Object({
  version: Type.String(),
  runtime: Type.Object({ key: Type.String({ pattern: '^[0-9a-f]{32}$' }), sha256: Hash }),
  plugin: Type.Object({ sha256: Hash }),
});
export type ServerRelease = Static<typeof ServerReleaseSchema>;
/** The fields of GitHub's release list this reads. */
const ReleasesSchema = Type.Array(Type.Object({
  tag_name: Type.String(), draft: Type.Boolean(), prerelease: Type.Boolean(),
}));

/** The release's description, its runtime's tarball, and InfiniChat's server plugin, as one module. */
export const RELEASE_FILE = 'release.json';
export const runtimeFile = (key: string) => `runtime-${key}.tar.gz`;
export const PLUGIN_FILE = 'infinichat.js';

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
  const release = await json(releaseFile(newest, RELEASE_FILE), signal);
  if (!Check(ServerReleaseSchema, release) || release.version !== newest) {
    throw new Error(`InfiniChat’s server release ${newest} has no valid description.`);
  }
  return release;
}
