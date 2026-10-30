import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  compareVersions, DAEMON_TARGETS, latestServerRelease, releaseFile,
} from '@pi-agent/infinichat/pi/infinichat-remote/release';

const DAY_MS = 24 * 60 * 60 * 1000;
/** pi-env's `UPLOAD_TIMEOUT_MS`, as an app's setup bounds the same download (`install.ts`). */
const DOWNLOAD_MS = 300_000;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/**
 * The file at `path` with the SHA-256 `expected`: kept when it has it, else downloaded beside it, verified and renamed
 * into place, readable by this account alone, as an app's setup places it.
 */
async function place(path: string, url: string, expected: string, signal: AbortSignal): Promise<void> {
  const current = await readFile(path).catch(() => undefined);
  if (current !== undefined && sha256(current) === expected) return;
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) });
  if (!response.ok) throw new Error(`${url} could not be downloaded (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} failed verification.`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Keeps this server on the newest release (`release.ts`): it checks at start, each day, and when an app asks with
 * SIGHUP (`requestUpdate`), downloads a newer one into its own folder beside this one, points `current` at it, and
 * calls `restart`, which ends this process so its service manager starts the new one. `folder` is the server folder
 * (`install.ts`'s `SERVER`), `release` the folder this server runs from, named after its version.
 */
export class ServerUpdates {
  private readonly controller = new AbortController();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly requested = () => {
    void this.check();
  };

  constructor(private readonly folder: string, private readonly release: string, private readonly version: string,
    private readonly restart: () => void) {}

  /** Removes the other releases' folders, which no service starts once this one runs, then checks for a newer one. */
  async start(): Promise<void> {
    for (const name of await readdir(this.folder)) {
      if (name !== this.release && name !== 'current' && name !== 'bin') {
        await rm(join(this.folder, name), { recursive: true, force: true });
      }
    }
    process.on('SIGHUP', this.requested);
    this.timer = setInterval(this.requested, DAY_MS);
    void this.check();
  }

  close(): void {
    process.off('SIGHUP', this.requested);
    clearInterval(this.timer);
    this.controller.abort();
  }

  /** One check at a time; a failed one is reported and the next check tries again. */
  private check(): Promise<void> {
    this.running ??= this.update().catch((error: unknown) => {
      if (!this.controller.signal.aborted) console.error('InfiniChat could not update:', error);
    }).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async update(): Promise<void> {
    const { signal } = this.controller;
    const release = await latestServerRelease(signal);
    if (release === undefined || compareVersions(release.version, this.version) <= 0) return;
    const { version } = release;
    await place(join(this.folder, version, 'server.js'), releaseFile(version, 'server.js'), release.sha256, signal);
    for (const target of DAEMON_TARGETS) {
      await place(join(this.folder, 'bin', `pi-env-${target}`, 'pi-env'), releaseFile(version, `pi-env-${target}`),
        release.daemons[target], signal);
    }
    signal.throwIfAborted();
    // A new link renamed over `current` replaces it at once.
    const link = join(this.folder, `current.${process.pid}`);
    await rm(link, { force: true });
    await symlink(version, link);
    await rename(link, join(this.folder, 'current'));
    this.restart();
  }
}
