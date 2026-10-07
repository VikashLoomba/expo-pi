import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Use an explicitly supplied daemon, or the documented external Pi Env 1.0.4 installation. */
export async function remoteDaemonPath() {
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const path = process.env.PI_ENV_DAEMON ?? join(homedir(), '.local/share/pi-env-test/node_modules/@earendil-works/pi-env',
    'bin', `pi-env-${process.platform}-${architecture}`, process.platform === 'win32' ? 'pi-env.exe' : 'pi-env');
  try { await access(path); return path; }
  catch { return undefined; }
}

/** Actual unchanged Pi daemon; only the binary channel transport uses child_process in Node tests. */
export async function remoteDaemonFixture(t, { fragment = false } = {}) {
  const daemonPath = await remoteDaemonPath();
  if (!daemonPath) throw new Error('Install Pi Env 1.0.4 outside the app as documented, or set PI_ENV_DAEMON.');
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
  });
  return { openChannel, directory, metrics, daemonPath, children };
}
