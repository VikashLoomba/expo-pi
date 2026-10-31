import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PLUGIN } from '@pi-agent/infinichat/pi/infinichat-remote/install';
import {
  compareVersions, latestServerRelease, PLUGIN_FILE, releaseFile, runtimeFile, ServerReleaseSchema, type ServerRelease,
} from '@pi-agent/infinichat/pi/infinichat-remote/release';
import { Check } from 'typebox/value';

const DAY_MS = 24 * 60 * 60 * 1000;
/** pi-env's `UPLOAD_TIMEOUT_MS`, as an app's setup bounds the same download (`install.ts`). */
const DOWNLOAD_MS = 300_000;
/** The release a runtime folder was installed with, beside its `main.js`. */
const RELEASE = 'release.json';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The release `runtime` holds, or undefined for one not installed from a release, which never updates. */
export async function installedRelease(runtime: string): Promise<ServerRelease | undefined> {
  const text = await readFile(join(runtime, RELEASE), 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  return Check(ServerReleaseSchema, value) ? value : undefined;
}

/** A release file, verified against `expected`. */
async function download(url: string, expected: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) });
  if (!response.ok) throw new Error(`${url} could not be downloaded (${response.status}).`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${url} failed verification.`);
  return bytes;
}

/** Writes beside `path` and renames into place, readable by this account alone, as an app's setup places a file. */
async function place(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Keeps this server on the newest release (`release.ts`): it checks at start, each day, and when an app asks with
 * SIGHUP (`requestUpdate`), and `restart`s into a newer one, which ends this process so its service manager starts it.
 * InfiniChat's plugin is the code its long-lived parts run: the sign-ins, the other machines' connections and the open
 * conversation's Harness, whose own code reaches nearly every module the extensions share, documents included. So a
 * release takes effect as pi-durable takes host code: the Harness closes, waiting for running task code, and the next
 * process installs the extensions again, where pending work resumes (README "Reload", "Errors"). Explicit plugin
 * reload retains those resources and refreshes extension configuration (`plugins.ts`); a release replaces host code
 * and still needs this restart. A release on this runtime replaces the plugin in
 * place; one on another runtime, a change of Chord, pi or this host itself, is unpacked into a folder beside this one,
 * and `current` names it. `folder` is the server folder (`install.ts`'s `SERVER`), `runtime` the folder this host
 * runs from.
 */
export class ServerUpdates {
  private readonly controller = new AbortController();
  private running?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly requested = () => {
    void this.check();
  };

  constructor(private readonly folder: string, private readonly runtime: string,
    private readonly installed: ServerRelease, private readonly restart: () => void) {}

  /** Removes the folders no service starts any more, other runtimes and earlier layouts, then checks. */
  async start(): Promise<void> {
    for (const name of await readdir(this.folder)) {
      if (name !== this.installed.runtime.key && name !== 'current') {
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
    if (release === undefined || compareVersions(release.version, this.installed.version) <= 0) return;
    const { version, runtime, plugin } = release;
    const pluginBytes = await download(releaseFile(version, PLUGIN_FILE), plugin.sha256, signal);
    if (runtime.key === this.installed.runtime.key) {
      await place(join(this.runtime, PLUGIN), pluginBytes);
      await place(join(this.runtime, RELEASE), JSON.stringify(release));
      this.restart();
      return;
    }
    const target = join(this.folder, runtime.key);
    const unpacked = `${target}.${process.pid}`;
    const tarball = `${unpacked}.tar.gz`;
    try {
      await place(tarball, await download(releaseFile(version, runtimeFile(runtime.key)), runtime.sha256, signal));
      await rm(unpacked, { recursive: true, force: true });
      await mkdir(unpacked, { recursive: true, mode: 0o700 });
      await promisify(execFile)('tar', ['-xzf', tarball, '-C', unpacked], { signal });
      await place(join(unpacked, PLUGIN), pluginBytes);
      await place(join(unpacked, RELEASE), JSON.stringify(release));
      await rm(target, { recursive: true, force: true });
      await rename(unpacked, target);
    } finally {
      await rm(tarball, { force: true });
      await rm(unpacked, { recursive: true, force: true });
    }
    signal.throwIfAborted();
    // A new link renamed over `current` replaces it at once.
    const link = join(this.folder, `current.${process.pid}`);
    await rm(link, { force: true });
    await symlink(runtime.key, link);
    await rename(link, join(this.folder, 'current'));
    this.restart();
  }
}
