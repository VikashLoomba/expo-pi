import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { PI_DAEMON_MANIFEST } = await import('../../src/pi/execution/remote/daemon-manifest.ts');
const target = `${process.platform}-${process.arch}`;

/** The daemon the app ships for this host, run from an executable copy; only the channel transport uses child_process. */
export async function remoteDaemonFixture(t, { fragment = false } = {}) {
  if (!(target in PI_DAEMON_MANIFEST)) throw new Error(`The app ships no Pi daemon for this host (${target}).`);
  const daemonDirectory = await mkdtemp(join(tmpdir(), 'pi-env-daemon-'));
  const daemonPath = join(daemonDirectory, 'pi-env');
  await copyFile(new URL(`../../assets/pi-env/pi-env-${target}.bin`, import.meta.url), daemonPath);
  await chmod(daemonPath, 0o700);
  const directory = await mkdtemp(join(tmpdir(), 'pi-mobile-remote-'));
  const children = new Set();
  const metrics = { sessions: 0, writes: 0, stderrBytes: 0, closes: 0 };
  const openChannel = async ({ token, signal, onData, onClosed }) => {
    if (signal.aborted) throw new Error('Channel opening cancelled');
    const child = spawn(daemonPath, ['serve', '--token', token], { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    metrics.sessions += 1;
    let closed = false;
    let resolveExit;
    const exited = new Promise((resolve) => { resolveExit = resolve; });
    child.stdout.on('data', (bytes) => {
      if (fragment) {
        for (let start = 0; start < bytes.length; start += 37) onData(bytes.subarray(start, start + 37));
      } else onData(bytes);
    });
    child.stderr.on('data', (bytes) => { metrics.stderrBytes += bytes.length; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => onClosed(error));
    child.on('close', () => {
      children.delete(child);
      signal.removeEventListener('abort', abort);
      onClosed();
      resolveExit();
    });
    const close = async () => {
      if (!closed) { closed = true; metrics.closes += 1; child.stdin.end(); child.kill(); }
      await exited;
    };
    const abort = () => { void close(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return {
      write(bytes) { metrics.writes += 1; child.stdin.write(bytes); },
      close,
    };
  };
  t.after(async () => {
    await Promise.all([...children].map((child) => new Promise((resolve) => { child.once('close', resolve); child.kill(); })));
    await rm(directory, { recursive: true, force: true });
    await rm(daemonDirectory, { recursive: true, force: true });
  });
  return { openChannel, directory, metrics, children };
}
